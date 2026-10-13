// "How it works, in depth" in French, Chinese and Bangla: the whole page per language (head, pipeline, sections in the
// same order as DEEP_SECTIONS in about-deep.js). Formulas, code names and road names stay as they are. Keep in step with
// the English when it changes; a language without an entry shows the English.

const DEEP_I18N = {
  fr: {
    kicker: "Le fonctionnement en détail",
    h1: "Sous le capot",
    lede: "Un planificateur de road trips est un petit pipeline de données : un modèle de langage propose, et du code déterministe vérifie, mesure et corrige. Voici chaque étape, la méthode derrière et les chiffres qui la font tourner.",
    pipeline: "Le pipeline de planification",
    sectionsLabel: "Sections",
    flow: [["Demande", "texte + options"], ["Plan", "LLM, JSON Schema"], ["Contrôle", "règles, une correction"], ["Géocodage", "5 candidats chacun"], ["Décodage", "Viterbi"], ["Nettoyage", "détours, 2-opt"], ["Itinéraire", "ORS / OSRM"], ["Routes", "appariement + insertion"], ["Journées", "PD"], ["Enrichir", "altitudes, météo, POI"], ["Guide", "LLM, en flux"]],
    sections: [
      ["Le planificateur : un LLM avec un schéma et un contrôleur", `
    <p class="dp-q">Problème : les modèles de langage écrivent des plans fluides mais avec des erreurs de structure (sept jours quand on en demande six, une journée qui ne finit pas à son étape du soir, une route phare sur laquelle aucun arrêt ne se trouve).</p>
    <p>Le modèle n'écrit jamais le plan en texte libre. Sa sortie est contrainte par un <b>JSON Schema</b> (<code>responseJsonSchema</code> chez Gemini, ou <code>response_format: json_schema</code> pour un modèle local dans LM Studio) : le décodage ne peut produire qu'un JSON valide avec les champs attendus (jours, points, routes phares). Avant cela, Flash-Lite cassait parfois son JSON ; avec le schéma, 5 plans de test sur 5 (dont les 3 qui avaient cassé) ont été lus du premier coup.</p>
    <p>Ensuite un validateur déterministe, <code>checkPlan</code>, teste le plan contre les règles que le modèle enfreint souvent :</p>
    <ul>
      <li>le nombre de jours correspond à la demande (lu dans « 7 days », « seven-day », « two weeks »)</li>
      <li>le dernier arrêt de chaque jour est son étape du soir (comparaison souple : « Milepost 382, Asheville, NC » vaut « Asheville »)</li>
      <li>une boucle finit là où elle commence ; au plus 9 points par jour et 50 au total</li>
      <li>chaque route phare a au moins un point dont le champ <code>road</code> la nomme (sinon aucun calcul d'itinéraire ne l'empruntera)</li>
      <li>aucun nom de lieu recopié des exemples des instructions dans un voyage sans rapport</li>
    </ul>
    <p>Les problèmes sont renvoyés au modèle sous forme de phrases, une fois. Le plan corrigé n'est gardé que s'il a <b>moins</b> de problèmes que le premier : une acceptation gloutonne, car une correction peut aussi empirer les choses.</p>
    <p><b>Ancrage.</b> La demande contient un catalogue de 399 vraies routes : les 184 National Scenic Byways et All-American Roads des États-Unis (tirées du tableau de Wikipédia) et 215 parcours célèbres choisis à la main dans les autres pays, chacun vérifié avec un article de Wikipédia. Un modèle local à contexte de 32k ne reçoit que les routes des États traversés : un premier appel peu coûteux nomme les États, ce qui sert d'étape de récupération (Denver à Moab : 20 routes sur 184).</p>
    <p><b>Flux.</b> La réponse arrive jeton par jeton. <code>partialJson</code> parcourt le texte avec une pile de crochets, coupe au dernier objet ou tableau fermé et referme les crochets ouverts : l'écran montre des jours et des arrêts entiers pendant que le reste s'écrit.</p>
    <div class="dp-nums"><span>nouvel essai après 8 s puis 20 s si occupé</span><span>3 modèles de secours</span><span>modèle local à température 0,3</span><span>~3 s par plan avec Flash-Lite</span></div>`],
      ["Des noms de lieux aux coordonnées : décoder l'itinéraire le plus probable", `
    <p class="dp-q">Problème : les noms sont ambigus. « Green River, Utah » est une ville sur l'I-70 et une rivière près de Flaming Gorge ; il existe des dizaines de Springfield. Prendre chaque premier résultat isolément place certains arrêts à des centaines de km.</p>
    <p>Chaque point reçoit jusqu'à <var>k</var> = 5 candidats de Nominatim (OpenStreetMap). En choisir un par point revient à un <b>plus court chemin dans un graphe en couches</b>, la même structure que le décodage de Viterbi dans un modèle de Markov caché : les états sont les candidats, le coût de transition est la distance orthodromique entre choix successifs, et le coût d'émission est une pénalité de 100 km pour un candidat qui n'est ni une localité ni un lieu notable (rivières, lacs, restes administratifs).</p>
    <div class="dp-math">C<sub>t</sub>(j) = min<sub>i</sub> [ C<sub>t−1</sub>(i) + d(c<sub>t−1,i</sub>, c<sub>t,j</sub>) ] + π(c<sub>t,j</sub>)</div>
    <p>Remonter depuis l'état final le moins coûteux donne tout l'itinéraire d'un coup, en O(<var>n</var>·<var>k</var>²). La distance est la formule de haversine sur une sphère de 6 371 km de rayon :</p>
    <div class="dp-math">d = 2R · asin √( sin²(Δφ/2) + cos φ<sub>1</sub> cos φ<sub>2</sub> sin²(Δλ/2) )</div>
    <p>Quand tous les candidats sont de l'eau, une seconde recherche limitée aux localités passe d'abord. Résultats : Blue River (C.-B.) est passé d'une correspondance près du Yukon (un voyage de 3 918 km) à la bonne ville ; Green River donne 38,995, −110,162.</p>`],
      ["Nettoyer la suite d'arrêts : valeurs aberrantes et retours en arrière", `
    <p class="dp-q">Problème : les petits modèles placent un point de passage loin de la ligne entre ses voisins, ou visitent les arrêts en zigzag (Sydney, les Snowy Mountains, retour sur la côte, puis Melbourne).</p>
    <p><b>Valeurs aberrantes.</b> Un point de passage dont le détour dépasse max(60 km, 50 % de la distance directe) est retiré, de même qu'un point à moins de 2 km du précédent (sauf une étape du soir répétée, qui est un jour de repos).</p>
    <div class="dp-math">detour = d(a, v) + d(v, b) − d(a, b) &gt; max(60 km, 0.5 · d(a, b))</div>
    <p><b>Ordre.</b> Réordonner avec un départ et une arrivée fixes est une version « chemin » du problème du voyageur de commerce. L'appli fait une recherche locale jusqu'à un optimum local : <b>2-opt</b> (inverser une portion quand cela raccourcit le trajet) et <b>Or-opt</b> (déplacer une suite de 1 à 3 points ailleurs, dans un sens ou l'autre), jusqu'à 40 passes. Un nouvel ordre n'est accepté que s'il économise au moins 8 % <i>et</i> 40 km, pour que les détours voulus survivent. Ce seuil privilégie la précision au rappel : une correction manquée coûte un peu de route, une mauvaise réécrit le voyage. Les journées gardent leurs villes du soir.</p>
    <div class="dp-nums"><span>Vancouver à Calgary : 345 km économisés</span><span>test en Nouvelle-Zélande : 324 km</span></div>`],
      ["Calcul d'itinéraire et cache des trajets", `
    <p>Chaque voyage est calculé deux fois : l'itinéraire panoramique par tous les points, et le plus rapide par les seules étapes, pour comparer. OpenRouteService (un calculateur sur les données OpenStreetMap) renvoie la géométrie en triplets [lng, lat, altitude], les distances et temps par tronçon, les noms et numéros de routes, et des indicateurs par segment (autoroute, péage, ferry, non revêtu). Quand son quota est épuisé ou qu'il est en panne, les serveurs publics OSRM répondent à sa place et la réponse est convertie dans la même forme : rien en aval ne voit la différence. Les très longs voyages sont découpés en morceaux de ~4 000 km ou 45 points au plus, raccordés en décalant leurs indices.</p>
    <p>Les itinéraires sont mis en cache sur disque sous un SHA-1 du profil et des points arrondis à 5 décimales (environ 1 m), pendant 30 jours. Les réponses « impossible d'y aller » restent un jour ; les erreurs de quota et de réseau jamais. Au plus 400 fichiers ; toutes les 25 écritures, les expirés et les plus anciens au-delà de la limite sont supprimés.</p>`],
      ["La route phare est-elle vraiment parcourue ? Appariement et insertion", `
    <p class="dp-q">Problème : le planificateur nomme Skyline Drive et place ses points de passage à Front Royal et Luray. Le calcul prend alors la route plus rapide de la vallée et le voyage ne passe jamais par Skyline Drive. Un audit hors ligne des 35 voyages tout prêts l'a trouvé dans 19 d'entre eux.</p>
    <p><b>Appariement.</b> Les segments sont rapprochés des routes phares par numéro normalisé (« US 50 », « AB 93 », « B100 », « Fv63 », « E 10 » donnent tous un type et un numéro, avec des règles par pays) ou par nom. Beaucoup de routes de parcs n'ont pas de nom dans les données de calcul, donc un tronçon compte aussi s'il suit la forme de la route dans OpenStreetMap : jusqu'à 12 échantillons, dont au moins 70 % à moins de 250 m de la polyligne.</p>
    <div class="dp-math">share = (1/m) Σ<sub>k</sub> 1[ dist(p<sub>k</sub>, shape) &lt; 250 m ] ≥ 0.7</div>
    <p>La distance point-segment utilise une projection équirectangulaire locale (x multiplié par cos φ), précise à bien moins de 1 % à ces distances et bien moins coûteuse que les géodésiques.</p>
    <p><b>Insertion.</b> Une route parcourue sur moins de 5 miles reçoit des points tirés de sa géométrie OSM (l'exemplaire le plus proche des points du plan : il existe des Skyline Drive en Virginie, près d'Asheville et au Tennessee). Ils sont insérés par l'heuristique d'<b>insertion la moins chère</b> : l'intervalle entre deux arrêts, et le sens, qui ajoutent le moins de distance.</p>
    <div class="dp-math">Δ = d(a, r<sub>1</sub>) + L(r) + d(r<sub>m</sub>, b) − d(a, b)</div>
    <div class="dp-nums"><span>Skyline Drive : 0 → 97 km parcourus</span><span>Trollstigen : 0 → 69 km</span></div>`],
      ["Découper le voyage en journées : une programmation dynamique exacte", `
    <p class="dp-q">Problème : connaissant le temps de conduite mesuré de chaque tronçon, choisir où dormir pour que la plus longue journée soit la plus courte possible.</p>
    <p>C'est le problème de la <b>partition linéaire</b>. Avec S les sommes cumulées des temps et une pénalité de 15 minutes pour dormir à un point de passage plutôt qu'à une vraie étape :</p>
    <div class="dp-math">f(d, i) = min<sub>k&lt;i</sub> max( f(d−1, k), S(i) − S(k) + p·1[i is a via] )</div>
    <p>Rempli en O(<var>D</var>·<var>n</var>²) puis remonté, il est exact, donc il passe avant toute demande à l'IA. Sans nombre de jours demandé, il essaie jusqu'à deux jours de plus. Ce n'est que si aucun découpage ne règle les longues journées que l'IA rééquilibre (déplacer d'abord les nuits, puis retirer des extras, en gardant chaque lieu nommé), au plus deux fois, et seulement tant que chaque tour aide.</p>`],
      ["Altitude : traitement du signal sur des hauteurs bruitées", `
    <p class="dp-q">Problème : additionner chaque montée des données brutes surestime énormément le dénivelé. Le total d'ORS pour Vancouver à Calgary était de 26 700 m, car chaque cellule de 30 m près d'une route en corniche ajoute une bosse.</p>
    <ol>
      <li><b>Rééchantillonner par longueur.</b> Les sommets sont irréguliers (denses dans les virages, rares en ligne droite), donc l'altitude est prise tous les 100 m le long de la ligne.</li>
      <li><b>Lisser.</b> Une moyenne mobile centrée sur ±200 m.</li>
      <li><b>Hystérésis.</b> La montée ne compte qu'une fois l'altitude 3 m au-delà de la dernière référence, ce qui élimine le reste du bruit.</li>
      <li><b>Kilomètre le plus raide.</b> Deux pointeurs font glisser une fenêtre d'1 km ; le plus grand |Δh|/distance est la pente maximale.</li>
    </ol>
    <div class="dp-math">ẽ<sub>i</sub> = (1 / (2w+1)) Σ<sub>j=−w…w</sub> e<sub>i+j</sub>,&nbsp;&nbsp; climb += ẽ − ref when ẽ − ref &gt; 3 m</div>
    <p>Les itinéraires de secours n'ont pas d'altitudes ; elles viennent de l'API d'altitude d'Open-Meteo, qui compte chaque point comme une requête. D'où un budget : au plus ~300 échantillons par trajet, un cache par cellules de ~100 m (gardé un an), et 1 500 points par heure, 3 000 par jour.</p>`],
      ["À quel point une route est-elle sinueuse ? Une mesure de courbure", `
    <p>Chaque route reçoit une note tirée de sa géométrie parcourue : la somme des changements de cap absolus par km, version discrète de l'intégrale de |courbure| le long du trajet. Les segments de moins de 4 m sont ignorés (bruit des sommets). Une épingle est un virage cumulé de 150° ou plus en 250 m.</p>
    <div class="dp-math">κ̄ = Σ<sub>i</sub> |Δθ<sub>i</sub>| / L&nbsp;&nbsp;(degrés par km)</div>
    <p>Elle dépend de la densité avec laquelle le calcul dessine les virages ; elle a donc été calibrée sur des routes connues plutôt qu'en théorie, et les cinq niveaux suivent une échelle à peu près logarithmique (40, 100, 200, 400 °/km) :</p>
    <table class="dp-table"><thead><tr><th>Route</th><th>°/km</th></tr></thead><tbody>
      <tr><td>Icefields Parkway</td><td>28</td></tr>
      <tr><td>Une autoroute à travers le Nevada</td><td>~30</td></tr>
      <tr><td>Sea-to-Sky Highway</td><td>98</td></tr>
      <tr><td>Big Sur, Highway 1</td><td>~210</td></tr>
      <tr><td>Beartooth Highway</td><td>~245</td></tr>
      <tr><td>Tail of the Dragon, US 129</td><td>~710</td></tr>
    </tbody></table>`],
      ["Requêtes spatiales", `
    <ul>
      <li><b>Couverture.</b> Dans quel pays est un arrêt : test point-dans-polygone par lancer de rayon sur les contours Natural Earth (fusionnés, puis simplifiés avec Turf, dans cet ordre sinon des coutures apparaissent). Les côtes simplifiées coupent des villes côtières, donc un échec sonde 8 points à ~5 km autour. Résultats mémorisés à 3 décimales.</li>
      <li><b>Lieux de la journée.</b> Chaque site est projeté sur la ligne du jour : sommet le plus proche (ligne sous-échantillonnée à 3 000 au plus), ce qui donne la distance parcourue et l'écart. Cela ordonne la chronologie et signale les lieux à plus de 25 km du trajet.</li>
      <li><b>Trous de carburant.</b> Les stations sont projetées de la même façon ; le plus grand écart entre positions triées donne l'alerte.</li>
      <li><b>Points d'intérêt.</b> Carburant, bornes, points de vue et hébergements viennent d'Overpass (le moteur de requêtes d'OSM). Les grandes requêtes « autour de la ligne » saturaient la mémoire des serveurs publics, donc la ligne est couverte de tuiles de 0,25° (environ 28 sur 20 km), chacune en cache 60 jours et gardée un an en secours quand tous les serveurs échouent.</li>
      <li><b>Routes près de chez moi.</b> Le temps de trajet depuis chez soi est estimé sans calcul d'itinéraire : distance à vol d'oiseau × 1,3 (un facteur de détour routier courant) à 80 km/h, plus 15 minutes. Les routes sur une autre terre (l'Irlande depuis le pays de Galles, la Tasmanie) sont écartées.</li>
    </ul>`],
      ["Météo, soleil et fuseaux horaires", `
    <p>À moins de 16 jours, la météo est la prévision d'Open-Meteo. Au-delà, c'est la <b>climatologie</b> : la moyenne des mêmes dates sur les trois dernières années de l'archive historique, indiquée « habituelle ». Les prévisions sont rafraîchies après 6 heures ; les valeurs habituelles sont gardées.</p>
    <p>Lever, coucher et heure dorée (soleil à 6°) sont calculés localement avec les équations solaires de la NOAA (anomalie moyenne, équation du centre, longitude écliptique, déclinaison, angle horaire), précises à environ une minute, et affichés dans le fuseau IANA de chaque lieu : la chronologie peut dire « départ 8:00 AM PDT, arrivée 8:28 PM MDT » et prévenir quand une journée finit de nuit.</p>`],
      ["Sources de données, limites et caches", `
    <p>Tout tourne sur des services gratuits, sans clé ou en offre gratuite ; l'essentiel du travail consiste donc à être un client poli : limites de débit, caches et solutions de secours.</p>
    <table class="dp-table"><thead><tr><th>Source</th><th>Utilisée pour</th><th>Limites et cache</th></tr></thead><tbody>
      <tr><td>Gemini, ou un modèle local</td><td>plans, guides du jour, réponses</td><td>modèles de secours, nouvels essais, usage par modèle et par jour</td></tr>
      <tr><td>OpenRouteService</td><td>itinéraires avec altitudes</td><td>quota quotidien ; cache de 30 jours ; pause de 30 min après un refus</td></tr>
      <tr><td>OSRM</td><td>itinéraires de secours</td><td>1 requête par seconde ; cache d'un jour</td></tr>
      <tr><td>Nominatim</td><td>recherche de lieux, formes des routes</td><td>1 requête par seconde, une file pour tous les appareils ; cache de 30 jours</td></tr>
      <tr><td>Overpass</td><td>carburant, bornes, sites, hébergements</td><td>3 serveurs dans l'ordre, pause pour ceux qui refusent ; cache par tuiles de 0,25°</td></tr>
      <tr><td>Wikipédia, Commons</td><td>photos, articles</td><td>file à 300 ms d'intervalle, pause après des 429 ; cache disque</td></tr>
      <tr><td>Open-Meteo</td><td>météo, altitudes</td><td>budget de points par heure et par jour ; caches</td></tr>
      <tr><td>Tavily (facultatif)</td><td>recherche web pour le planificateur</td><td>compte mensuel, arrêt à 900 sur 1 000</td></tr>
    </tbody></table>
    <p>Les <b>photos</b> sont choisies selon le lieu, pas seulement le nom : d'abord une recherche géographique à 3 km d'un emplacement connu, sinon une recherche par nom qui écarte les photos situées à plus de 150 km des arrêts du jour, et un article trouvé par recherche doit partager un mot distinctif avec le nom.</p>`],
      ["Tests et évaluation", `
    <ul>
      <li><b>Tests unitaires</b> (<code>npm test</code>, 16 tests) : la PD de découpage, le découpage des liens de carte, l'appariement de formes et de numéros de routes, les contrôles du plan, le lecteur de JSON partiel, le découpage des trajets, le stockage compact des itinéraires. Les fonctions pures sont dans un fichier chargé à la fois par le navigateur et par Node.</li>
      <li><b>Test de fumée</b> (<code>npm run smoke</code>) : Chrome sans interface ouvre chaque vue et chaque panneau en taille bureau et téléphone, et échoue sur une erreur de console, un défilement latéral ou des crédits de carte masqués. axe-core vérifie le contraste et l'accessibilité (0 problème au niveau WCAG AA).</li>
      <li><b>Une évaluation hors ligne de la qualité des plans</b> (<code>tools/audit-trips.mjs</code>) : applique les mesures de l'appli à tous les voyages tout prêts et signale les journées trop longues ou courtes, les routes phares non parcourues, les retours en arrière, les lieux loin du trajet, les altitudes et photos manquantes. C'est elle qui a trouvé les 19 voyages avec une route non parcourue.</li>
      <li><b>Une évaluation du planificateur</b> (<code>npm run eval</code>) : 30 demandes fixes dans toutes les régions, passées par un modèle et tout le pipeline, en notant chaque étape. Avec Gemini Flash-Lite, chaque plan passait les contrôles après la correction, mais seuls 42 % des voyages étaient entièrement bons une fois calculés (chaque route phare parcourue, aucune journée au-delà de la limite). Le passage des routes les a portés à 62 % et la PD de découpage à 69 % : les étapes déterministes ajoutent 27 points. Sur 30 demandes, les intervalles sont larges (environ ±20 points) : on mesure les grands effets, pas les petits.</li>
    </ul>
    <p><b>Limites honnêtes.</b> La plupart des seuils (8 % et 40 km, 250 m et 70 %, la pénalité de 100 km, les niveaux de courbure) ont été réglés à la main sur quelques dizaines de voyages, pas ajustés sur des données étiquetées. Il n'existe pas de vérité terrain pour « un bon road trip », le LLM n'est pas déterministe, et l'audit mesure la structure (la route est-elle parcourue, une journée est-elle trop longue) plutôt que le plaisir qu'on y prendrait.</p>`],
    ],
  },

  zh: {
    kicker: "深入了解运作原理",
    h1: "幕后原理",
    lede: "公路旅行规划器其实是一条小型数据管线：语言模型负责提出方案，确定性代码负责检查、测量和修正。下面是每一步、背后的方法以及它所依据的数字。",
    pipeline: "规划管线",
    sectionsLabel: "章节",
    flow: [["需求", "文字 + 选项"], ["规划", "LLM，JSON Schema"], ["检查", "规则，修正一次"], ["地理编码", "每个 5 个候选"], ["解码", "Viterbi"], ["清理", "绕路，2-opt"], ["路线", "ORS / OSRM"], ["公路", "匹配 + 插入"], ["分日", "动态规划"], ["补充", "海拔、天气、兴趣点"], ["指南", "LLM，流式"]],
    sections: [
      ["规划器：带模式约束和检查器的 LLM", `
    <p class="dp-q">问题：语言模型写出的方案很流畅，却常有结构性错误（要 6 天却给 7 天、某天没有在当晚的过夜地结束、某条精选公路上一个站点都没有）。</p>
    <p>模型从不以自由文本写方案。它的输出受 <b>JSON Schema</b> 约束（Gemini 的 <code>responseJsonSchema</code>，或 LM Studio 本地模型的 <code>response_format: json_schema</code>），因此解码只能生成带有预期字段的合法 JSON：天、点（站点或途经点、第几天、所在公路）、精选公路。在此之前，Flash-Lite 偶尔会写坏 JSON；加上模式后，5 个测试方案（包括之前坏掉的 3 个）全部一次解析成功。</p>
    <p>随后，确定性的校验器 <code>checkPlan</code> 用模型常犯的规则检查方案：</p>
    <ul>
      <li>天数与需求一致（从 “7 days”“seven-day”“two weeks” 中解析）</li>
      <li>每天最后一个站点就是当晚过夜地（模糊匹配：“Milepost 382, Asheville, NC” 等于 “Asheville”）</li>
      <li>环线回到起点；每天最多 9 个点，总共最多 50 个</li>
      <li>每条精选公路至少有一个点的 <code>road</code> 字段写着它（否则路由永远不会走这条路）</li>
      <li>不能把指令示例里的地名照搬到无关的行程里</li>
    </ul>
    <p>问题以句子形式退回给模型一次。修正后的方案只有在问题<b>更少</b>时才会被采用：这是一种贪心接受，因为修正也可能让情况变糟。</p>
    <p><b>事实依据。</b>提示词附带一份 399 条真实公路的目录：美国 184 条国家风景道和全美公路（取自维基百科表格），以及其他国家 215 条人工挑选的著名路线，每条都核对过维基百科条目。上下文为 32k 的本地模型只拿到途经州的公路：先用一次低成本调用列出途经的州，相当于一个检索步骤（丹佛到摩押：184 条中取 20 条）。</p>
    <p><b>流式输出。</b>答案逐个词元流式返回。<code>partialJson</code> 用括号栈扫描文本，在最后一个闭合的对象或数组处截断，并补齐未闭合的括号，这样屏幕上能先显示完整的天和站点，其余部分还在继续生成。</p>
    <div class="dp-nums"><span>繁忙时 8 秒、20 秒后重试</span><span>3 个备用模型</span><span>本地模型温度 0.3</span><span>Flash-Lite 每个方案约 3 秒</span></div>`],
      ["从地名到坐标：解码最可能的路线", `
    <p class="dp-q">问题：地名有歧义。“Green River, Utah” 既是 I-70 上的小镇，也是 Flaming Gorge 旁的一条河；叫 Springfield 的地方有几十个。每个点各自取第一个搜索结果，会让一些站点偏离几百公里。</p>
    <p>每个点从 OpenStreetMap 的 Nominatim 获取最多 <var>k</var> = 5 个候选。为每个点各选一个，就是<b>分层图中的最短路径</b>，与隐马尔可夫模型中的 Viterbi 解码结构相同：状态是候选，转移代价是相邻选择之间的大圆距离，发射代价是对非城镇或地标候选（河流、湖泊、行政区残留）施加的 100 公里惩罚。</p>
    <div class="dp-math">C<sub>t</sub>(j) = min<sub>i</sub> [ C<sub>t−1</sub>(i) + d(c<sub>t−1,i</sub>, c<sub>t,j</sub>) ] + π(c<sub>t,j</sub>)</div>
    <p>从代价最低的终态回溯，就能一次得到整条路线，复杂度 O(<var>n</var>·<var>k</var>²)。距离用半径 6,371 公里球面上的半正矢公式：</p>
    <div class="dp-math">d = 2R · asin √( sin²(Δφ/2) + cos φ<sub>1</sub> cos φ<sub>2</sub> sin²(Δλ/2) )</div>
    <p>如果所有候选都是水体，会先做一次只限城镇的搜索。结果：Blue River（不列颠哥伦比亚省）从育空附近的匹配（导致 3,918 公里的行程）变成了正确的小镇；Green River 解析为 38.995, −110.162。</p>`],
      ["清理站点序列：异常点和走回头路", `
    <p class="dp-q">问题：小模型会把途经点放得离相邻两点的连线很远，或者让站点之字形排列（悉尼、雪山、回到海岸、再去墨尔本）。</p>
    <p><b>异常点。</b>绕路超过 max(60 公里, 直线距离的 50%) 的途经点会被删除；距上一个点不到 2 公里的点也会删除（重复的过夜地除外，那是休息日）。</p>
    <div class="dp-math">detour = d(a, v) + d(v, b) − d(a, b) &gt; max(60 km, 0.5 · d(a, b))</div>
    <p><b>顺序。</b>在起点和终点固定的情况下重新排序，是旅行商问题的路径版本。应用做局部搜索直到局部最优：<b>2-opt</b>（如果反转一段能缩短路径就反转）和 <b>Or-opt</b>（把 1 到 3 个连续点按任一方向移到别处），最多 40 轮。新顺序只有在至少节省 8% <i>且</i> 40 公里时才采用，以保留有意的绕行。这个阈值以召回换精确：漏掉一次修正只是多开一点路，错误的修正会改写旅行者的行程。每天保留原来的过夜城镇。</p>
    <div class="dp-nums"><span>温哥华到卡尔加里：节省 345 公里</span><span>新西兰测试：324 公里</span></div>`],
      ["路线规划与路线缓存", `
    <p>每个行程会计算两次路线：经过所有点的风景路线，以及只经过站点的最快路线，用于对比。OpenRouteService（基于 OpenStreetMap 数据的路由器）返回 [经度, 纬度, 海拔] 三元组形式的几何、每段的距离和时间、道路名称和编号，以及每段的标记（高速、收费、渡轮、未铺装）。当它额度用完或宕机时，改由公共 OSRM 服务器应答，并把结果转换成相同格式，下游完全感觉不到区别。很长的行程会分段计算（每段最多约 4,000 公里或 45 个点），再平移索引拼接起来。</p>
    <p>路线以配置文件和保留 5 位小数（约 1 米）的点的 SHA-1 为键缓存在磁盘上，保留 30 天。“无法到达”的结果缓存一天；额度和网络错误从不缓存。最多 400 个文件；每写入 25 次，会删除过期文件和超出上限的最旧文件。</p>`],
      ["精选公路真的开过了吗？匹配与插入", `
    <p class="dp-q">问题：规划器写了 Skyline Drive，却把途经点放在 Front Royal 和 Luray。路由于是走更快的河谷公路，行程根本没开 Skyline Drive。对 35 个现成行程的离线审计在其中 19 个里发现了这个问题。</p>
    <p><b>匹配。</b>路段按标准化的编号（“US 50”“AB 93”“B100”“Fv63”“E 10”都会解析为类型加数字，各国有各自的规则）或按名称与精选公路匹配。很多公园道路在路由数据里没有名字，因此如果一段路沿着 OpenStreetMap 中该公路的形状走，也算数：沿路段最多取 12 个样本点，其中至少 70% 距公路折线不超过 250 米。</p>
    <div class="dp-math">share = (1/m) Σ<sub>k</sub> 1[ dist(p<sub>k</sub>, shape) &lt; 250 m ] ≥ 0.7</div>
    <p>点到线段的距离使用局部等距圆柱投影（x 乘以 cos φ），在这个尺度上误差远小于 1%，而且比测地线计算便宜得多。</p>
    <p><b>插入。</b>开过不到 5 英里的公路，会从它的 OSM 几何中取点（选离方案中该公路上的点最近的那一条：弗吉尼亚、阿什维尔附近和田纳西都有叫 Skyline Drive 的路）。这些点用<b>最廉价插入</b>启发式插入：选择增加距离最少的相邻站点间隔和方向。</p>
    <div class="dp-math">Δ = d(a, r<sub>1</sub>) + L(r) + d(r<sub>m</sub>, b) − d(a, b)</div>
    <div class="dp-nums"><span>Skyline Drive：0 → 97 公里</span><span>Trollstigen：0 → 69 公里</span></div>`],
      ["把行程分成几天：精确的动态规划", `
    <p class="dp-q">问题：已知每段测得的驾驶时间，选择在哪里过夜，使最长的一天尽可能短。</p>
    <p>这是<b>线性划分</b>问题。设 S 为各段时间的前缀和，在途经点（而非正式站点）过夜加 15 分钟惩罚：</p>
    <div class="dp-math">f(d, i) = min<sub>k&lt;i</sub> max( f(d−1, k), S(i) − S(k) + p·1[i is a via] )</div>
    <p>以 O(<var>D</var>·<var>n</var>²) 填表再回溯，结果是精确的，因此在询问任何 AI 之前先运行。如果需求没有指定天数，它最多尝试多加两天。只有当没有任何划分能解决过长的日程时，才让 AI 重新平衡（先调整过夜地，再删减额外内容，保留每个指定的地点），最多两轮，且只在每轮都有改善时保留。</p>`],
      ["海拔：对含噪高度做信号处理", `
    <p class="dp-q">问题：把原始海拔数据中的每次上升都加起来，会严重高估爬升。ORS 给出的温哥华到卡尔加里总爬升是 26,700 米，因为悬崖公路旁每个 30 米的高程格都会带来一个“凸起”。</p>
    <ol>
      <li><b>按弧长重采样。</b>路线顶点分布不均（弯道密、直道疏），所以沿线每 100 米取一次海拔。</li>
      <li><b>平滑。</b>在 ±200 米范围内做中心移动平均。</li>
      <li><b>滞回。</b>只有当高度超过上一个参考值 3 米时才计入爬升，去掉剩余的抖动。</li>
      <li><b>最陡一公里。</b>双指针沿样本滑动一个 1 公里窗口；最大的 |Δh|/距离 就是最陡坡度。</li>
    </ol>
    <div class="dp-math">ẽ<sub>i</sub> = (1 / (2w+1)) Σ<sub>j=−w…w</sub> e<sub>i+j</sub>,&nbsp;&nbsp; climb += ẽ − ref when ẽ − ref &gt; 3 m</div>
    <p>备用路线没有海拔，需要从 Open-Meteo 的海拔 API 获取，而它把每个点都算作一次请求。因此需要预算：每条路线最多约 300 个样本、按约 100 米网格缓存（保留一年），以及每小时 1,500 个点、每天 3,000 个点。</p>`],
      ["一条路有多弯？曲率指标", `
    <p>每条公路根据实际行驶的几何得到评分：每公里航向变化绝对值之和，相当于沿路径对 |曲率| 积分的离散版本。短于 4 米的线段忽略（顶点噪声）。发夹弯指 250 米内累计同向转弯达 150° 或以上。</p>
    <div class="dp-math">κ̄ = Σ<sub>i</sub> |Δθ<sub>i</sub>| / L&nbsp;&nbsp;(每公里度数)</div>
    <p>它取决于路由器绘制弯道的密度，因此是用已知公路校准的，而不是靠理论；五个等级大致呈对数刻度（40、100、200、400 度/公里）：</p>
    <table class="dp-table"><thead><tr><th>公路</th><th>度/公里</th></tr></thead><tbody>
      <tr><td>Icefields Parkway</td><td>28</td></tr>
      <tr><td>穿越内华达的州际公路</td><td>~30</td></tr>
      <tr><td>Sea-to-Sky Highway</td><td>98</td></tr>
      <tr><td>Big Sur, Highway 1</td><td>~210</td></tr>
      <tr><td>Beartooth Highway</td><td>~245</td></tr>
      <tr><td>Tail of the Dragon, US 129</td><td>~710</td></tr>
    </tbody></table>`],
      ["空间查询", `
    <ul>
      <li><b>覆盖范围。</b>判断站点所在国家：在 Natural Earth 轮廓上做射线法点在多边形判断（先合并、再用 Turf 简化，顺序反了会出现接缝）。简化后的海岸线会把沿海城镇切在外面，所以没命中时会在周围约 5 公里探测 8 个点。结果按 3 位小数缓存。</li>
      <li><b>当天沿途地点。</b>每个景点投影到当天的路线上：取最近的顶点（路线最多抽样到 3,000 个点），得到沿线距离和偏离距离。据此排列时间线，并标出偏离路线超过 25 公里的地点。</li>
      <li><b>加油空白。</b>加油站用同样方法投影；排序后相邻位置的最大间隔就是提醒。</li>
      <li><b>兴趣点。</b>加油站、充电桩、观景点和住宿来自 Overpass（OSM 的查询引擎）。大范围的“沿线”查询会让公共服务器内存耗尽，所以把路线用 0.25° 的瓦片（约 28×20 公里）覆盖，每块缓存 60 天，并在所有服务器都失败时作为旧数据保留一年。</li>
      <li><b>我附近的公路。</b>从家出发的车程不做路由，直接估算：直线距离 × 1.3（常见的道路迂回系数），按 80 公里/小时，再加 15 分钟。位于另一块陆地上的公路（从威尔士看爱尔兰、塔斯马尼亚）会被排除。</li>
    </ul>`],
      ["天气、太阳与时区", `
    <p>16 天以内的天气是 Open-Meteo 的预报。更远的日期使用<b>气候统计</b>：历史档案中过去三年相同日期的平均值，标注为“通常”。预报 6 小时后刷新；“通常”值一直保留。</p>
    <p>日出、日落和黄金时刻（太阳高度 6°）在本地用 NOAA 太阳方程计算（平近点角、中心差、黄经、赤纬、时角），精度约一分钟，并以各地的 IANA 时区显示，因此时间线可以写“8:00 AM PDT 出发，8:28 PM MDT 到达”，并在某天天黑后才结束时提醒。</p>`],
      ["数据来源、频率限制与缓存", `
    <p>所有服务都是免费、无需密钥或免费额度的，所以大部分工程工作是做一个守规矩的客户端：频率限制、缓存和备用方案。</p>
    <table class="dp-table"><thead><tr><th>来源</th><th>用途</th><th>限制与缓存</th></tr></thead><tbody>
      <tr><td>Gemini 或本地模型</td><td>规划、每日指南、问答</td><td>备用模型、繁忙重试、按模型按日统计用量</td></tr>
      <tr><td>OpenRouteService</td><td>带海拔的路线</td><td>每日额度；30 天路线缓存；被拒后暂停 30 分钟</td></tr>
      <tr><td>OSRM</td><td>备用路线</td><td>每秒 1 次请求；缓存一天</td></tr>
      <tr><td>Nominatim</td><td>地点搜索、道路形状</td><td>每秒 1 次请求，所有设备共用一个队列；缓存 30 天</td></tr>
      <tr><td>Overpass</td><td>加油站、充电桩、景点、住宿</td><td>依次使用 3 个服务器，拒绝的暂停；0.25° 瓦片缓存</td></tr>
      <tr><td>维基百科、维基共享资源</td><td>照片、文章</td><td>串行队列间隔 300 毫秒，遇到 429 暂停；磁盘缓存</td></tr>
      <tr><td>Open-Meteo</td><td>天气、海拔</td><td>每小时和每天的点数预算；缓存</td></tr>
      <tr><td>Tavily（可选）</td><td>规划器的网页搜索</td><td>按月计数，1,000 次中用到 900 次即停止</td></tr>
    </tbody></table>
    <p><b>照片</b>按地点而不只是按名称匹配：先在已知位置 3 公里内做地理搜索，否则按名称搜索并丢弃距当天站点 150 公里以外的照片；通过搜索找到的条目必须与名称有共同的特征词。</p>`],
      ["测试与评估", `
    <ul>
      <li><b>单元测试</b>（<code>npm test</code>，16 个）：分日动态规划、地图链接拆分、形状匹配、道路编号匹配、方案检查、部分 JSON 解析、路线分段、压缩的路线存储。纯函数放在一个浏览器和 Node 都会加载的文件里。</li>
      <li><b>冒烟测试</b>（<code>npm run smoke</code>）：无头 Chrome 以桌面和手机尺寸打开每个视图和面板，遇到控制台错误、横向滚动或地图版权信息被遮挡就失败。axe-core 检查对比度和无障碍（WCAG AA 下 0 个问题）。</li>
      <li><b>方案质量的离线评估</b>（<code>tools/audit-trips.mjs</code>）：用应用自己的测量检查所有现成行程，报告过长或过短的日程、没开过的精选公路、可修正的回头路、偏离路线的地点，以及缺失的海拔和照片。正是它发现了 19 个有精选公路没开到的行程。</li>
      <li><b>规划器评估</b>（<code>npm run eval</code>）：覆盖所有地区的 30 个固定需求，经过一个模型和整条管线，记录每个阶段。使用 Gemini Flash-Lite 时，每个方案在一次修正后都通过了规则检查，但计算路线后只有 42% 的行程完全正确（每条精选公路都开到、没有一天超过上限）。公路补点把它提高到 62%，分日动态规划提高到 69%：确定性步骤共增加 27 个百分点。30 个需求的置信区间很宽（约 ±20 个百分点），所以它衡量的是大效应，而不是小差异。</li>
    </ul>
    <p><b>坦白说明局限。</b>大多数阈值（8% 和 40 公里、250 米和 70%、100 公里惩罚、曲率等级）是在几十个行程上手工调出来的，而不是在标注数据上拟合的。“好的公路旅行”没有标准答案，LLM 也不是确定性的，而且审计衡量的是结构（公路有没有开到、有没有哪天太长），而不是人是否会喜欢这趟旅行。</p>`],
    ],
  },

  bn: {
    kicker: "বিস্তারিতভাবে কীভাবে কাজ করে",
    h1: "ভেতরের কলকবজা",
    lede: "একটি রোড ট্রিপ পরিকল্পনাকারী আসলে একটি ছোট ডেটা পাইপলাইন: একটি ভাষা মডেল প্রস্তাব দেয়, আর নির্ধারিত কোড যাচাই করে, মাপে ও ঠিক করে। এখানে প্রতিটি ধাপ, তার পেছনের পদ্ধতি আর যে সংখ্যাগুলোর উপর তা চলে।",
    pipeline: "পরিকল্পনার পাইপলাইন",
    sectionsLabel: "অংশগুলো",
    flow: [["অনুরোধ", "লেখা + বিকল্প"], ["পরিকল্পনা", "LLM, JSON Schema"], ["যাচাই", "নিয়ম, একবার সংশোধন"], ["জিওকোড", "প্রতিটিতে ৫টি প্রার্থী"], ["ডিকোড", "Viterbi"], ["পরিষ্কার", "ঘুরপথ, 2-opt"], ["পথ", "ORS / OSRM"], ["রাস্তা", "মেলানো + ঢোকানো"], ["দিনে ভাগ", "ডিপি"], ["সমৃদ্ধকরণ", "উচ্চতা, আবহাওয়া, আগ্রহের স্থান"], ["গাইড", "LLM, স্ট্রিম"]],
    sections: [
      ["পরিকল্পনাকারী: স্কিমা ও যাচাইকারীসহ একটি LLM", `
    <p class="dp-q">সমস্যা: ভাষা মডেল সাবলীল পরিকল্পনা লেখে, কিন্তু কাঠামোগত ভুল থাকে (ছয় দিন চাইলে সাত দিন, এমন একটি দিন যা রাত কাটানোর জায়গায় শেষ হয় না, এমন একটি বিশেষ রাস্তা যার উপর কোনো স্টপ নেই)।</p>
    <p>মডেল কখনো পরিকল্পনা মুক্ত লেখায় লেখে না। এর আউটপুট একটি <b>JSON Schema</b>-তে বাঁধা (Gemini-এর <code>responseJsonSchema</code>, বা LM Studio-র স্থানীয় মডেলের জন্য <code>response_format: json_schema</code>), তাই ডিকোডিং কেবল প্রত্যাশিত ঘরসহ বৈধ JSON তৈরি করতে পারে: দিন, বিন্দু (স্টপ বা মধ্যবর্তী বিন্দু, কোন দিন, কোন রাস্তায়), বিশেষ রাস্তা। এর আগে Flash-Lite মাঝে মাঝে JSON ভেঙে ফেলত; স্কিমা দেওয়ার পর ৫টি পরীক্ষামূলক পরিকল্পনার ৫টিই (যে ৩টি আগে ভেঙেছিল সেগুলোসহ) প্রথমবারেই পড়া গেছে।</p>
    <p>তারপর একটি নির্ধারিত যাচাইকারী, <code>checkPlan</code>, মডেল যেসব নিয়ম প্রায়ই ভাঙে সেগুলো দিয়ে পরিকল্পনা পরীক্ষা করে:</p>
    <ul>
      <li>দিনের সংখ্যা অনুরোধের সাথে মেলে (“7 days”, “seven-day”, “two weeks” থেকে পড়া)</li>
      <li>প্রতিটি দিনের শেষ স্টপই সেই রাতের থাকার জায়গা (নমনীয় মিল: “Milepost 382, Asheville, NC” মানে “Asheville”)</li>
      <li>লুপ যেখানে শুরু সেখানেই শেষ হয়; দিনে সর্বোচ্চ ৯টি আর মোট ৫০টি বিন্দু</li>
      <li>প্রতিটি বিশেষ রাস্তায় অন্তত একটি বিন্দু আছে যার <code>road</code> ঘরে সেই রাস্তার নাম (নইলে কোনো রাউটার কখনো সে রাস্তায় যাবে না)</li>
      <li>নির্দেশনার উদাহরণ থেকে কোনো জায়গার নাম অন্য ভ্রমণে নকল করা হয়নি</li>
    </ul>
    <p>সমস্যাগুলো একবার বাক্য আকারে মডেলের কাছে ফেরত যায়। সংশোধিত পরিকল্পনা কেবল তখনই রাখা হয় যখন প্রথমটির চেয়ে <b>কম</b> সমস্যা থাকে: একটি লোভী গ্রহণ ধাপ, কারণ সংশোধন অবস্থা খারাপও করতে পারে।</p>
    <p><b>ভিত্তি।</b> অনুরোধের সাথে ৩৯৯টি আসল রাস্তার একটি তালিকা যায়: যুক্তরাষ্ট্রের ১৮৪টি ন্যাশনাল সিনিক বাইওয়ে ও অল-আমেরিকান রোড (উইকিপিডিয়ার সারণি থেকে নেওয়া) এবং অন্য দেশগুলোর হাতে বাছাই করা ২১৫টি বিখ্যাত পথ, প্রতিটি উইকিপিডিয়ার নিবন্ধ দিয়ে যাচাই করা। ৩২k কনটেক্সটের স্থানীয় মডেল শুধু যে রাজ্যগুলো পার হয় সেগুলোর রাস্তা পায়: একটি সস্তা প্রথম কল রাজ্যগুলোর নাম বলে, যা একটি তথ্য-উদ্ধারের ধাপ হিসেবে কাজ করে (ডেনভার থেকে মোয়াব: ১৮৪টির মধ্যে ২০টি)।</p>
    <p><b>স্ট্রিমিং।</b> উত্তর টোকেন ধরে ধরে আসে। <code>partialJson</code> একটি বন্ধনী-স্ট্যাক দিয়ে লেখা পড়ে, শেষ বন্ধ হওয়া অবজেক্ট বা অ্যারেতে কাটে আর খোলা বন্ধনীগুলো বন্ধ করে দেয়, তাই বাকিটা লেখা চলাকালীন পর্দায় পুরো দিন ও স্টপ দেখা যায়।</p>
    <div class="dp-nums"><span>ব্যস্ত থাকলে ৮ সেকেন্ড, তারপর ২০ সেকেন্ড পরে আবার চেষ্টা</span><span>৩টি বিকল্প মডেল</span><span>স্থানীয় মডেলের তাপমাত্রা ০.৩</span><span>Flash-Lite-এ প্রতি পরিকল্পনায় ~৩ সেকেন্ড</span></div>`],
      ["জায়গার নাম থেকে স্থানাঙ্ক: সবচেয়ে সম্ভাব্য পথ ডিকোড করা", `
    <p class="dp-q">সমস্যা: নাম দ্ব্যর্থক। “Green River, Utah” I-70-এর একটি শহর, আবার Flaming Gorge-এর কাছের একটি নদীও; Springfield নামে ডজনখানেক জায়গা আছে। প্রতিটির প্রথম সার্চ ফল আলাদাভাবে নিলে কিছু স্টপ শত শত কিলোমিটার দূরে চলে যায়।</p>
    <p>প্রতিটি বিন্দু OpenStreetMap-এর Nominatim থেকে সর্বোচ্চ <var>k</var> = ৫টি প্রার্থী পায়। প্রতিটি বিন্দুর জন্য একটি বাছাই করা হলো একটি <b>স্তরে সাজানো গ্রাফে সংক্ষিপ্ততম পথ</b>, যা হিডেন মার্কভ মডেলের Viterbi ডিকোডিংয়ের একই কাঠামো: অবস্থাগুলো প্রার্থী, পরিবর্তনের খরচ পরপর বাছাইয়ের মধ্যে মহাবৃত্ত দূরত্ব, আর নির্গমন খরচ হলো এমন প্রার্থীর জন্য ১০০ কিমি জরিমানা যা জনবসতি বা দর্শনীয় স্থান নয় (নদী, হ্রদ, প্রশাসনিক অবশিষ্টাংশ)।</p>
    <div class="dp-math">C<sub>t</sub>(j) = min<sub>i</sub> [ C<sub>t−1</sub>(i) + d(c<sub>t−1,i</sub>, c<sub>t,j</sub>) ] + π(c<sub>t,j</sub>)</div>
    <p>সবচেয়ে কম খরচের শেষ অবস্থা থেকে পেছনে ফিরলে একবারে পুরো পথ পাওয়া যায়, O(<var>n</var>·<var>k</var>²)-এ। দূরত্ব হলো ৬,৩৭১ কিমি ব্যাসার্ধের গোলকে হ্যাভারসাইন সূত্র:</p>
    <div class="dp-math">d = 2R · asin √( sin²(Δφ/2) + cos φ<sub>1</sub> cos φ<sub>2</sub> sin²(Δλ/2) )</div>
    <p>সব প্রার্থী জলাশয় হলে আগে শুধু জনবসতি খোঁজার একটি দ্বিতীয় সার্চ চলে। ফলাফল: Blue River (ব্রিটিশ কলাম্বিয়া) ইউকনের কাছের একটি মিল (৩,৯১৮ কিমির ভ্রমণ) থেকে সঠিক শহরে এসেছে; Green River দাঁড়ায় 38.995, −110.162-এ।</p>`],
      ["স্টপের ক্রম পরিষ্কার করা: ব্যতিক্রমী বিন্দু ও পেছনে ফেরা", `
    <p class="dp-q">সমস্যা: ছোট মডেল একটি মধ্যবর্তী বিন্দুকে তার প্রতিবেশীদের মাঝের রেখা থেকে অনেক দূরে বসায়, অথবা আঁকাবাঁকা ক্রমে স্টপে যায় (সিডনি, স্নোয়ি মাউন্টেনস, আবার উপকূলে, তারপর মেলবোর্ন)।</p>
    <p><b>ব্যতিক্রমী বিন্দু।</b> যে মধ্যবর্তী বিন্দুর ঘুরপথ max(৬০ কিমি, সরাসরি দূরত্বের ৫০%)-এর বেশি, তা বাদ যায়; আগেরটি থেকে ২ কিমির কম দূরের বিন্দুও বাদ যায় (পুনরাবৃত্ত রাত কাটানোর জায়গা ছাড়া, যা একটি বিশ্রামের দিন)।</p>
    <div class="dp-math">detour = d(a, v) + d(v, b) − d(a, b) &gt; max(60 km, 0.5 · d(a, b))</div>
    <p><b>ক্রম।</b> শুরু ও শেষ ঠিক রেখে আবার সাজানো ট্রাভেলিং সেলসম্যান সমস্যার একটি পথ-সংস্করণ। অ্যাপ স্থানীয় সর্বোত্তমে পৌঁছা পর্যন্ত স্থানীয় অনুসন্ধান চালায়: <b>2-opt</b> (একটি অংশ উল্টে দিলে পথ ছোট হলে উল্টানো) ও <b>Or-opt</b> (১ থেকে ৩টি পরপর বিন্দু যেকোনো দিকে অন্য জায়গায় সরানো), সর্বোচ্চ ৪০ বার। নতুন ক্রম কেবল তখনই নেওয়া হয় যখন অন্তত ৮% <i>এবং</i> ৪০ কিমি বাঁচে, যাতে ইচ্ছাকৃত ঘুরপথ টিকে থাকে। এই সীমা রিকলের বদলে নির্ভুলতা বেছে নেয়: একটি সংশোধন বাদ পড়লে একটু বেশি চালাতে হয়, ভুল সংশোধন ভ্রমণটাই বদলে দেয়। দিনগুলো তাদের রাত কাটানোর শহর রাখে।</p>
    <div class="dp-nums"><span>ভ্যাঙ্কুভার থেকে ক্যালগারি: ৩৪৫ কিমি বাঁচল</span><span>নিউজিল্যান্ড পরীক্ষা: ৩২৪ কিমি</span></div>`],
      ["পথ নির্ণয় ও পথের ক্যাশ", `
    <p>প্রতিটি ভ্রমণের পথ দুবার হিসাব করা হয়: সব বিন্দু দিয়ে মনোরম পথ, আর তুলনার জন্য শুধু স্টপ দিয়ে দ্রুততম পথ। OpenRouteService (OpenStreetMap ডেটার উপর একটি রাউটার) জ্যামিতি দেয় [দ্রাঘিমা, অক্ষাংশ, উচ্চতা] ত্রয়ী হিসেবে, প্রতিটি অংশের দূরত্ব ও সময়, রাস্তার নাম ও নম্বর, আর প্রতিটি অংশের চিহ্ন (ফ্রিওয়ে, টোল, ফেরি, কাঁচা রাস্তা)। এর কোটা শেষ হলে বা বন্ধ থাকলে পাবলিক OSRM সার্ভার উত্তর দেয় এবং উত্তরটি একই আকারে রূপান্তরিত হয়, তাই পরের ধাপগুলো পার্থক্য টেরই পায় না। খুব লম্বা ভ্রমণ সর্বোচ্চ ~৪,০০০ কিমি বা ৪৫টি বিন্দুর টুকরোয় হিসাব হয়, তারপর সূচক সরিয়ে জোড়া লাগে।</p>
    <p>পথগুলো প্রোফাইল আর ৫ দশমিক (প্রায় ১ মিটার) পর্যন্ত গোল করা বিন্দুর SHA-1 দিয়ে ডিস্কে ৩০ দিন ক্যাশ থাকে। “সেখানে যাওয়া যায় না” উত্তর এক দিন থাকে; কোটা ও নেটওয়ার্ক ত্রুটি কখনো না। সর্বোচ্চ ৪০০টি ফাইল; প্রতি ২৫টি লেখার পর মেয়াদোত্তীর্ণ ও সীমার বাইরের সবচেয়ে পুরোনোগুলো মুছে যায়।</p>`],
      ["বিশেষ রাস্তাটি কি সত্যিই চালানো হচ্ছে? মেলানো ও ঢোকানো", `
    <p class="dp-q">সমস্যা: পরিকল্পনাকারী Skyline Drive-এর নাম বলে আর মধ্যবর্তী বিন্দু রাখে Front Royal ও Luray-তে। রাউটার তখন উপত্যকার দ্রুত রাস্তা নেয় আর ভ্রমণে Skyline Drive চালানোই হয় না। ৩৫টি তৈরি ভ্রমণের একটি অফলাইন অডিটে ১৯টিতে এটি পাওয়া গেছে।</p>
    <p><b>মেলানো।</b> পথের অংশগুলো বিশেষ রাস্তার সাথে মেলানো হয় স্বাভাবিকীকৃত নম্বর দিয়ে (“US 50”, “AB 93”, “B100”, “Fv63”, “E 10” সবই দেশভিত্তিক নিয়মে একটি ধরন ও সংখ্যায় পড়া হয়) বা নাম দিয়ে। অনেক পার্কের রাস্তার রাউটিং ডেটায় নাম নেই, তাই কোনো অংশ OpenStreetMap-এ রাস্তার আকৃতি অনুসরণ করলেও গোনা হয়: অংশ ধরে সর্বোচ্চ ১২টি নমুনা, যার অন্তত ৭০% রাস্তার রেখা থেকে ২৫০ মিটারের মধ্যে।</p>
    <div class="dp-math">share = (1/m) Σ<sub>k</sub> 1[ dist(p<sub>k</sub>, shape) &lt; 250 m ] ≥ 0.7</div>
    <p>বিন্দু থেকে রেখাংশের দূরত্বে একটি স্থানীয় সমদূরবর্তী-আয়তাকার প্রক্ষেপ ব্যবহার হয় (x-কে cos φ দিয়ে গুণ), যা এই দূরত্বে ১%-এর অনেক কম ভুল দেয় আর জিওডেসিকের চেয়ে অনেক সস্তা।</p>
    <p><b>ঢোকানো।</b> যে রাস্তা ৫ মাইলের কম চালানো হয়, তার OSM জ্যামিতি থেকে বিন্দু নেওয়া হয় (পরিকল্পনায় সেই রাস্তার বিন্দুগুলোর সবচেয়ে কাছেরটি: ভার্জিনিয়ায়, অ্যাশভিলের কাছে আর টেনেসিতে Skyline Drive আছে)। সেগুলো <b>সবচেয়ে সস্তা ঢোকানো</b> কৌশলে বসে: পরপর দুটি স্টপের যে ফাঁক ও দিক সবচেয়ে কম দূরত্ব যোগ করে।</p>
    <div class="dp-math">Δ = d(a, r<sub>1</sub>) + L(r) + d(r<sub>m</sub>, b) − d(a, b)</div>
    <div class="dp-nums"><span>Skyline Drive: ০ → ৯৭ কিমি চালানো</span><span>Trollstigen: ০ → ৬৯ কিমি</span></div>`],
      ["ভ্রমণকে দিনে ভাগ করা: একটি নির্ভুল ডায়নামিক প্রোগ্রামিং", `
    <p class="dp-q">সমস্যা: প্রতিটি অংশের মাপা ড্রাইভিং সময় জানা থাকলে, কোথায় রাত কাটাবেন তা এমনভাবে বাছা যাতে সবচেয়ে লম্বা দিনটি যত ছোট সম্ভব হয়।</p>
    <p>এটি <b>লিনিয়ার পার্টিশন</b> সমস্যা। S হলো অংশগুলোর সময়ের প্রিফিক্স যোগফল, আর আসল স্টপের বদলে মধ্যবর্তী বিন্দুতে রাত কাটালে ১৫ মিনিট জরিমানা:</p>
    <div class="dp-math">f(d, i) = min<sub>k&lt;i</sub> max( f(d−1, k), S(i) − S(k) + p·1[i is a via] )</div>
    <p>O(<var>D</var>·<var>n</var>²)-এ পূরণ করে পেছনে ফিরলে এটি নির্ভুল, তাই কোনো এআই-কে জিজ্ঞাসার আগেই চলে। অনুরোধে দিনের সংখ্যা না থাকলে এটি সর্বোচ্চ দুই দিন বেশি চেষ্টা করে। কোনো ভাগেই লম্বা দিন ঠিক না হলে তবেই এআই আবার ভারসাম্য করে (আগে রাত কাটানোর জায়গা সরায়, তারপর বাড়তি অংশ ছাঁটে, প্রতিটি উল্লেখিত জায়গা রেখে), সর্বোচ্চ দুবার, এবং প্রতিবার উন্নতি হলেই রাখা হয়।</p>`],
      ["উচ্চতা: গোলমেলে উচ্চতার উপর সিগন্যাল প্রসেসিং", `
    <p class="dp-q">সমস্যা: কাঁচা উচ্চতা ডেটার প্রতিটি উঠানামা যোগ করলে চড়াই অনেক বেশি দেখায়। ভ্যাঙ্কুভার থেকে ক্যালগারির জন্য ORS-এর নিজের হিসাব ছিল ২৬,৭০০ মিটার, কারণ খাড়া পাহাড়ের ধারের রাস্তার পাশে প্রতিটি ৩০ মিটার উচ্চতা-ঘর একটি করে উঁচুনিচু যোগ করে।</p>
    <ol>
      <li><b>দৈর্ঘ্য ধরে পুনরায় নমুনা।</b> পথের শীর্ষবিন্দু অসমান (বাঁকে ঘন, সোজা রাস্তায় পাতলা), তাই রেখা ধরে প্রতি ১০০ মিটারে উচ্চতা নেওয়া হয়।</li>
      <li><b>মসৃণ করা।</b> ±২০০ মিটার জুড়ে একটি কেন্দ্রিক চলমান গড়।</li>
      <li><b>হিস্টেরেসিস।</b> উচ্চতা শেষ রেফারেন্স থেকে ৩ মিটার পেরোলে তবেই চড়াই গোনা হয়, যা বাকি কাঁপুনি দূর করে।</li>
      <li><b>সবচেয়ে খাড়া কিলোমিটার।</b> দুটি পয়েন্টার নমুনা ধরে ১ কিমির একটি জানালা সরায়; সবচেয়ে বড় |Δh|/দূরত্বই সর্বোচ্চ ঢাল।</li>
    </ol>
    <div class="dp-math">ẽ<sub>i</sub> = (1 / (2w+1)) Σ<sub>j=−w…w</sub> e<sub>i+j</sub>,&nbsp;&nbsp; climb += ẽ − ref when ẽ − ref &gt; 3 m</div>
    <p>বিকল্প পথে উচ্চতা থাকে না, তাই তা আসে Open-Meteo-র উচ্চতা API থেকে, যা প্রতিটি বিন্দুকে একটি অনুরোধ হিসেবে গোনে। তাই একটি বাজেট লাগে: প্রতি পথে সর্বোচ্চ ~৩০০ নমুনা, ~১০০ মিটারের ঘর ধরে একটি ক্যাশ (এক বছর থাকে), আর ঘণ্টায় ১,৫০০ ও দিনে ৩,০০০ বিন্দু।</p>`],
      ["রাস্তা কতটা আঁকাবাঁকা? একটি বক্রতার মাপ", `
    <p>প্রতিটি রাস্তা তার চালানো জ্যামিতি থেকে একটি রেটিং পায়: প্রতি কিমিতে দিক পরিবর্তনের পরম মানের যোগফল, যা পথ ধরে |বক্রতা| সমাকলনের একটি বিচ্ছিন্ন রূপ। ৪ মিটারের ছোট অংশ বাদ দেওয়া হয় (শীর্ষবিন্দুর গোলমাল)। হেয়ারপিন হলো ২৫০ মিটারের মধ্যে একদিকে মোট ১৫০° বা তার বেশি বাঁক।</p>
    <div class="dp-math">κ̄ = Σ<sub>i</sub> |Δθ<sub>i</sub>| / L&nbsp;&nbsp;(প্রতি কিমিতে ডিগ্রি)</div>
    <p>এটি নির্ভর করে রাউটার কতটা ঘনভাবে বাঁক আঁকে তার উপর, তাই তত্ত্ব দিয়ে নয়, চেনা রাস্তা দিয়ে মাপ ঠিক করা হয়েছে, আর পাঁচটি স্তর মোটামুটি লগারিদমিক স্কেলে বসে (৪০, ১০০, ২০০, ৪০০ °/কিমি):</p>
    <table class="dp-table"><thead><tr><th>রাস্তা</th><th>°/কিমি</th></tr></thead><tbody>
      <tr><td>Icefields Parkway</td><td>28</td></tr>
      <tr><td>নেভাদা পার হওয়া একটি ইন্টারস্টেট</td><td>~30</td></tr>
      <tr><td>Sea-to-Sky Highway</td><td>98</td></tr>
      <tr><td>Big Sur, Highway 1</td><td>~210</td></tr>
      <tr><td>Beartooth Highway</td><td>~245</td></tr>
      <tr><td>Tail of the Dragon, US 129</td><td>~710</td></tr>
    </tbody></table>`],
      ["স্থানিক কোয়েরি", `
    <ul>
      <li><b>আওতা।</b> একটি স্টপ কোন দেশে: Natural Earth সীমারেখার উপর রে-কাস্টিং বিন্দু-বহুভুজ পরীক্ষা (আগে জোড়া, তারপর Turf দিয়ে সরল করা, এই ক্রমে নইলে জোড়ের দাগ দেখা দেয়)। সরল করা উপকূল উপকূলের শহর কেটে বাদ দেয়, তাই না মিললে চারপাশে ~৫ কিমিতে ৮টি বিন্দু পরীক্ষা করা হয়। ফলাফল ৩ দশমিকে মনে রাখা হয়।</li>
      <li><b>দিনের পথের জায়গা।</b> প্রতিটি দর্শনীয় স্থান দিনের রেখায় প্রক্ষেপ করা হয়: সবচেয়ে কাছের শীর্ষবিন্দু (রেখা সর্বোচ্চ ৩,০০০ বিন্দুতে নমুনা করা), যা পথ ধরে দূরত্ব আর পথ থেকে দূরত্ব দেয়। এতে সময়রেখা সাজানো হয় আর পথ থেকে ২৫ কিমির বেশি দূরের জায়গা চিহ্নিত হয়।</li>
      <li><b>জ্বালানির ফাঁক।</b> পেট্রোল পাম্পগুলোও একইভাবে প্রক্ষেপ করা হয়; সাজানো অবস্থানের মধ্যে সবচেয়ে বড় ফাঁকই সতর্কতা।</li>
      <li><b>আগ্রহের স্থান।</b> জ্বালানি, চার্জার, ভিউপয়েন্ট ও থাকার জায়গা আসে Overpass (OSM-এর কোয়েরি ইঞ্জিন) থেকে। “রেখার চারপাশ” ধরনের বড় কোয়েরিতে পাবলিক সার্ভারের মেমরি শেষ হয়ে যেত, তাই রেখাটি ০.২৫° টাইলে (প্রায় ২৮ × ২০ কিমি) ঢাকা হয়, প্রতিটি ৬০ দিন ক্যাশে থাকে আর সব সার্ভার ব্যর্থ হলে পুরোনো বিকল্প হিসেবে এক বছর রাখা হয়।</li>
      <li><b>আমার কাছের রাস্তা।</b> বাড়ি থেকে যাত্রার সময় পথ নির্ণয় ছাড়াই অনুমান করা হয়: সরলরেখার দূরত্ব × ১.৩ (রাস্তার সাধারণ ঘুরপথ গুণক), ঘণ্টায় ৮০ কিমি, সাথে ১৫ মিনিট। অন্য ভূখণ্ডের রাস্তা (ওয়েলস থেকে আয়ারল্যান্ড, তাসমানিয়া) বাদ দেওয়া হয়।</li>
    </ul>`],
      ["আবহাওয়া, সূর্য ও সময় অঞ্চল", `
    <p>১৬ দিনের মধ্যে আবহাওয়া হলো Open-Meteo-র পূর্বাভাস। তার পরে এটি <b>জলবায়ুগত গড়</b>: ঐতিহাসিক আর্কাইভ থেকে গত তিন বছরের একই তারিখগুলোর গড়, “সাধারণ” হিসেবে চিহ্নিত। পূর্বাভাস ৬ ঘণ্টা পরে নতুন করা হয়; সাধারণ মানগুলো রেখে দেওয়া হয়।</p>
    <p>সূর্যোদয়, সূর্যাস্ত ও সোনালি সময় (সূর্য ৬° উপরে) স্থানীয়ভাবে NOAA-র সৌর সমীকরণ দিয়ে হিসাব করা হয় (গড় অসংগতি, কেন্দ্রের সমীকরণ, ক্রান্তীয় দ্রাঘিমা, বিষুবলম্ব, ঘণ্টা কোণ), প্রায় এক মিনিট নির্ভুল, আর প্রতিটি জায়গার IANA সময় অঞ্চলে দেখানো হয়, তাই সময়রেখা বলতে পারে “রওনা 8:00 AM PDT, পৌঁছানো 8:28 PM MDT” এবং কোনো দিন অন্ধকারে শেষ হলে সতর্ক করতে পারে।</p>`],
      ["তথ্যের উৎস, হারের সীমা ও ক্যাশ", `
    <p>সবকিছু চলে বিনামূল্যের, কী-ছাড়া বা ফ্রি-প্ল্যানের সেবায়, তাই প্রকৌশলের বেশিরভাগটাই একজন ভদ্র ক্লায়েন্ট হওয়া: হারের সীমা, ক্যাশ আর বিকল্প ব্যবস্থা।</p>
    <table class="dp-table"><thead><tr><th>উৎস</th><th>যে কাজে ব্যবহার</th><th>সীমা ও ক্যাশ</th></tr></thead><tbody>
      <tr><td>Gemini, বা একটি স্থানীয় মডেল</td><td>পরিকল্পনা, দিনের গাইড, উত্তর</td><td>বিকল্প মডেল, ব্যস্ত হলে আবার চেষ্টা, মডেল ও দিনভিত্তিক ব্যবহার</td></tr>
      <tr><td>OpenRouteService</td><td>উচ্চতাসহ পথ</td><td>দৈনিক কোটা; ৩০ দিনের পথ ক্যাশ; প্রত্যাখ্যানের পর ৩০ মিনিট বিরতি</td></tr>
      <tr><td>OSRM</td><td>বিকল্প পথ</td><td>সেকেন্ডে ১টি অনুরোধ; এক দিনের ক্যাশ</td></tr>
      <tr><td>Nominatim</td><td>জায়গা খোঁজা, রাস্তার আকৃতি</td><td>সেকেন্ডে ১টি অনুরোধ, সব ডিভাইসের জন্য এক সারি; ৩০ দিনের ক্যাশ</td></tr>
      <tr><td>Overpass</td><td>জ্বালানি, চার্জার, দর্শনীয় স্থান, থাকার জায়গা</td><td>ক্রমে ৩টি সার্ভার, প্রত্যাখ্যানকারীরা বিরতিতে; ০.২৫° টাইল ক্যাশ</td></tr>
      <tr><td>উইকিপিডিয়া, কমন্স</td><td>ছবি, নিবন্ধ</td><td>৩০০ মিলিসেকেন্ড ব্যবধানে ধারাবাহিক সারি, 429-এর পর বিরতি; ডিস্ক ক্যাশ</td></tr>
      <tr><td>Open-Meteo</td><td>আবহাওয়া, উচ্চতা</td><td>ঘণ্টা ও দিনভিত্তিক বিন্দুর বাজেট; ক্যাশ</td></tr>
      <tr><td>Tavily (ঐচ্ছিক)</td><td>পরিকল্পনাকারীর ওয়েব সার্চ</td><td>মাসিক হিসাব, ১,০০০-এর মধ্যে ৯০০-তে থামে</td></tr>
    </tbody></table>
    <p><b>ছবি</b> শুধু নাম দিয়ে নয়, জায়গা দিয়ে মেলানো হয়: প্রথমে জানা অবস্থানের ৩ কিমির মধ্যে ভৌগোলিক খোঁজ, নইলে নাম দিয়ে খোঁজ যা দিনের স্টপ থেকে ১৫০ কিমির বেশি দূরের ছবি বাদ দেয়, আর খুঁজে পাওয়া নিবন্ধে নামের সাথে একটি স্বতন্ত্র শব্দ মিলতে হবে।</p>`],
      ["পরীক্ষা ও মূল্যায়ন", `
    <ul>
      <li><b>ইউনিট টেস্ট</b> (<code>npm test</code>, ১৬টি): দিনে ভাগের ডিপি, মানচিত্র লিঙ্ক ভাগ, আকৃতি মেলানো, রাস্তার নম্বর মেলানো, পরিকল্পনার যাচাই, আংশিক JSON পাঠক, পথ টুকরো করা, সংকুচিত পথ সংরক্ষণ। বিশুদ্ধ ফাংশনগুলো এমন একটি ফাইলে থাকে যা ব্রাউজার ও Node দুটোই লোড করে।</li>
      <li><b>স্মোক টেস্ট</b> (<code>npm run smoke</code>): হেডলেস Chrome ডেস্কটপ ও ফোন আকারে প্রতিটি ভিউ ও শিট খোলে, আর কনসোল ত্রুটি, পাশে স্ক্রল বা ঢেকে যাওয়া মানচিত্র কৃতিত্বে ব্যর্থ হয়। axe-core কনট্রাস্ট ও প্রবেশযোগ্যতা যাচাই করে (WCAG AA-তে ০টি সমস্যা)।</li>
      <li><b>পরিকল্পনার মানের একটি অফলাইন মূল্যায়ন</b> (<code>tools/audit-trips.mjs</code>): সব তৈরি ভ্রমণে অ্যাপের নিজের মাপগুলো চালায় এবং লম্বা ও ছোট দিন, না-চালানো বিশেষ রাস্তা, পুনর্বিন্যাসে ঠিক হবে এমন পেছনে ফেরা, পথ থেকে দূরের জায়গা আর অনুপস্থিত উচ্চতা ও ছবি জানায়। এটিই না-চালানো রাস্তাসহ ১৯টি ভ্রমণ খুঁজে পেয়েছিল।</li>
      <li><b>পরিকল্পনাকারীর মূল্যায়ন</b> (<code>npm run eval</code>): সব অঞ্চলের ৩০টি নির্দিষ্ট অনুরোধ, একটি মডেল ও পুরো পাইপলাইনের মধ্য দিয়ে, প্রতিটি ধাপ লিখে রাখে। Gemini Flash-Lite-এ একবার সংশোধনের পর প্রতিটি পরিকল্পনা নিয়ম-যাচাই পেরিয়েছে, কিন্তু পথ হিসাবের পর মাত্র ৪২% ভ্রমণ পুরোপুরি ঠিক ছিল (প্রতিটি বিশেষ রাস্তা চালানো, কোনো দিন সীমার বেশি নয়)। রাস্তা-ধাপ তা ৬২%-এ আর দিনে ভাগের ডিপি ৬৯%-এ তুলেছে: নির্ধারিত ধাপগুলো ২৭ পয়েন্ট যোগ করে। ৩০টি অনুরোধে আস্থার ব্যবধান চওড়া (প্রায় ±২০ পয়েন্ট), তাই এটি বড় প্রভাব মাপে, ছোটগুলো নয়।</li>
    </ul>
    <p><b>সৎ সীমাবদ্ধতা।</b> বেশিরভাগ সীমা (৮% ও ৪০ কিমি, ২৫০ মিটার ও ৭০%, ১০০ কিমি জরিমানা, বক্রতার স্তর) কয়েক ডজন ভ্রমণে হাতে ঠিক করা, লেবেল করা ডেটায় ফিট করা নয়। “ভালো রোড ট্রিপ”-এর কোনো নিশ্চিত মাপকাঠি নেই, LLM নির্ধারিত নয়, আর অডিট মাপে কাঠামো (রাস্তা চালানো হলো কিনা, কোনো দিন বেশি লম্বা কিনা), কেউ ভ্রমণটি উপভোগ করবে কিনা তা নয়।</p>`],
    ],
  },
};

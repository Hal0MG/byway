// Line icons on a 24x24 grid, drawn with currentColor so they follow the theme.
const ICON_PATHS = {
  viewpoint: '<path d="M2.5 20l6.5-10.5 4 6 2.5-3.5 6 8z"/><circle cx="17.5" cy="5.5" r="2"/>',
  hike: '<ellipse cx="8.5" cy="8" rx="2.6" ry="4.2"/><ellipse cx="15.5" cy="16" rx="2.6" ry="4.2"/>',
  food: '<path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10"/><path d="M17.5 3c-2 0-3.5 2.2-3.5 5.5 0 2.6 1.2 4 3.5 4V21"/>',
  landmark: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  park: '<path d="M12 2.5l6 8.5h-3.5l4.5 6.5H5L9.5 11H6z"/><path d="M12 17.5V21.5"/>',
  town: '<path d="M3 21V10l6-3v14M9 21V4l9 3.5V21M3 21h18M12.5 10h2M12.5 14h2M12.5 18h2"/>',
  photo: '<path d="M3.5 8h3.5l2-3h6l2 3h3.5v11.5h-17z"/><circle cx="12" cy="13.2" r="3.6"/>',
  moon: '<path d="M20 14.5A8.2 8.2 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  road: '<path d="M8.5 3L4 21M15.5 3L20 21M12 4.5v3M12 11v3M12 17.5v3"/>',
  map: '<path d="M9 4L3 6.2v13.8l6-2.2 6 2.2 6-2.2V4l-6 2.2z"/><path d="M9 4v13.8M15 6.2V20"/>',
  list: '<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18.5 14v6h-15V5.5h6"/>',
  pin: '<path d="M12 21.5s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12z"/><circle cx="12" cy="9.5" r="2.5"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  gauge: '<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M12 17l4.5-5.5"/><circle cx="12" cy="17" r="1"/>',
  route: '<circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="5" r="2.2"/><path d="M8.2 19H14a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h5.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  alert: '<path d="M12 3.5l9.5 17h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>',
  book: '<path d="M4 4.5h6a2 2 0 0 1 2 2V20a1.5 1.5 0 0 0-1.5-1.5H4zM20 4.5h-6a2 2 0 0 0-2 2V20a1.5 1.5 0 0 1 1.5-1.5H20z"/>',
  mountain: '<path d="M2 20l7-12 4 6 3-4 6 10z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3"/><circle cx="12" cy="12" r="6.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  hairpin: '<path d="M5 21V9a5 5 0 0 1 10 0v6a2 2 0 0 0 4 0V3"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  "trend-up": '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  "trend-down": '<path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10"/><path d="M14 8l3 2v7.5a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  plug: '<path d="M13 2L5 13h6l-1 9 8-11h-6z"/>',
  ferry: '<path d="M3 15l2 5h14l2-5H3zM6 15V9h12v6M9 9V5h6v4"/><path d="M2 21.5c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1"/>',
  toll: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5V8M12 16v1.5"/>',
  gravel: '<circle cx="6" cy="16" r="2"/><circle cx="12.5" cy="13" r="2.5"/><circle cx="18" cy="17" r="2"/><circle cx="9" cy="8" r="1.5"/><circle cx="16" cy="8" r="1.2"/>',
  print: '<path d="M6 9V3h12v6M6 18H4a1.5 1.5 0 0 1-1.5-1.5v-6A1.5 1.5 0 0 1 4 9h16a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 20 18h-2M6 14h12v7H6z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.5M8.2 13.2l7.6 4.5"/>',
  "chevron-left": '<path d="M15 5l-7 7 7 7"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 18.5z"/>',
  rain: '<path d="M7 14.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14.5z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  snow: '<path d="M7 14.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14.5z"/><path d="M8 18.5v.01M12 20v.01M16 18.5v.01M10 22v.01M14 22v.01"/>',
  storm: '<path d="M7 14.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14.5z"/><path d="M12.5 15l-2 3.5h3l-2 3.5"/>',
  fog: '<path d="M4 9h16M3 13h18M5 17h14M8 21h8"/>',
  sunset: '<path d="M4 18h16M7 21h10M12 3v5M5.6 9.6l1.4 1.4M18.4 9.6L17 11M7.5 18a4.5 4.5 0 0 1 9 0"/>',
  waterfall: '<path d="M4 4h16M7 4v10M12 4v13M17 4v10"/><path d="M3 20c2 0 2-1.5 4.5-1.5S10 20 12 20s2.5-1.5 4.5-1.5S19 20 21 20"/>',
  hot_spring: '<path d="M8 10c-1.5-2 1.5-3 0-5M12 10c-1.5-2 1.5-3 0-5M16 10c-1.5-2 1.5-3 0-5"/><path d="M3 15c0 3 4 5 9 5s9-2 9-5c-2 1-5.5 1.5-9 1.5S5 16 3 15z"/>',
};

function icon(name, size = 20, cls = "") {
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.pin}</svg>`;
}

// Brand mark: a road running into mountains.
const LOGO = `<svg class="logo" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
  <defs><linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a84ff"/><stop offset="1" stop-color="#30d1c6"/></linearGradient></defs>
  <rect width="32" height="32" rx="9" fill="url(#logo-g)"/>
  <path d="M4 19.5l6.5-8 4.5 5.5 3.5-4.5 9.5 7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M13.5 28.5l2-6.5M18.5 28.5l-2-6.5" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".85"/>
</svg>`;

const SPOT_TYPES = {
  viewpoint: { icon: "viewpoint", label: "Viewpoint" },
  hike: { icon: "hike", label: "Hike" },
  food: { icon: "food", label: "Food" },
  landmark: { icon: "landmark", label: "Landmark" },
  park: { icon: "park", label: "Park" },
  town: { icon: "town", label: "Town" },
  photo: { icon: "photo", label: "Photo spot" },
  waterfall: { icon: "waterfall", label: "Waterfall" },
  hot_spring: { icon: "hot_spring", label: "Hot spring" },
};
const spotType = (t) => SPOT_TYPES[t] || SPOT_TYPES.landmark;

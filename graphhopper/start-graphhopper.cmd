@echo off
setlocal
cd /d "%~dp0"

rem Usage: start-graphhopper.cmd [region] [memory]
rem   region: a US state name as Geofabrik spells it (california, nevada, utah, oregon...)
rem           or us-west for all western states in one map
rem   memory: Java heap size, default 8g (use 16g or more for us-west)
rem Examples:
rem   start-graphhopper.cmd california
rem   start-graphhopper.cmd us-west 16g

set GH_VERSION=11.1
set REGION=%~1
if "%REGION%"=="" set REGION=california
set HEAP=%~2
if "%HEAP%"=="" set HEAP=8g

if /i "%REGION%"=="us-west" (
  set MAP_URL=https://download.geofabrik.de/north-america/us-west-latest.osm.pbf
) else (
  set MAP_URL=https://download.geofabrik.de/north-america/us/%REGION%-latest.osm.pbf
)
set MAP_FILE=%REGION%-latest.osm.pbf
set JAR=graphhopper-web-%GH_VERSION%.jar

where java >nul 2>nul
if errorlevel 1 goto nojava
java --version 2>nul | findstr /r /i /c:"^[a-z]* 2[5-9]" /c:"^[a-z]* [3-9][0-9]" >nul
if errorlevel 1 goto oldjava

if not exist "%JAR%" (
  echo Downloading GraphHopper %GH_VERSION%...
  curl.exe -fL -o "%JAR%" https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/%GH_VERSION%/%JAR%
  if errorlevel 1 goto jarfail
)

if not exist "%MAP_FILE%" (
  echo Downloading map data for %REGION%. This can take a while...
  curl.exe -fL -o "%MAP_FILE%" %MAP_URL%
  if errorlevel 1 goto mapfail
)

if not exist "graph-%REGION%" (
  echo.
  echo First run for %REGION%: building the road graph. This takes from a few minutes
  echo for one state to an hour or more for us-west. Later starts are fast.
  echo.
)

java -Xmx%HEAP% -Ddw.graphhopper.datareader.file=%MAP_FILE% -Ddw.graphhopper.graph.location=graph-%REGION% -jar "%JAR%" server config.yml
goto end

:nojava
echo Java was not found. GraphHopper needs Java 25 or newer.
echo Install it with:  winget install EclipseAdoptium.Temurin.25.JDK
echo Then open a new terminal and run this again.
goto end

:oldjava
echo Your Java is older than 25, which GraphHopper %GH_VERSION% needs.
java --version
echo Install a newer one with:  winget install EclipseAdoptium.Temurin.25.JDK
echo Then open a new terminal and run this again.
goto end

:jarfail
echo Could not download GraphHopper. Check your internet connection and try again.
if exist "%JAR%" del "%JAR%"
goto end

:mapfail
echo Could not download the map. Check the region name at https://download.geofabrik.de/north-america/us.html
if exist "%MAP_FILE%" del "%MAP_FILE%"
goto end

:end
endlocal

@echo off
rem Starts LM Studio's local server and loads the planning model on the GPU.
rem Run this once before planning trips (it can stay running). The model stays loaded until you close LM Studio.
setlocal
set LMS=%USERPROFILE%\.lmstudio\bin\lms.exe
set MODEL=qwen/qwen3.5-9b
rem Context length: room for the prompt, search results and the answer. 32768 uses about 6 GB of GPU memory.
set CONTEXT=32768

if not exist "%LMS%" (
  echo LM Studio's command line tool wasn't found at %LMS%. Open LM Studio once, then try again.
  goto end
)
"%LMS%" server start
"%LMS%" unload --all >nul 2>nul
"%LMS%" load %MODEL% --context-length %CONTEXT% --gpu max -y
echo.
echo Ready. Start the app with npm.cmd start and plan a trip.
:end
endlocal

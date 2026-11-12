@echo off
rem model_atlas web UI - double-click to start. Optional argument: port (default 8877).
setlocal
cd /d "%~dp0"
set "PORT=8877"
if not "%~1"=="" set "PORT=%~1"

rem Find a working Python 3.9+ (py launcher first; "python" may be the Microsoft Store stub).
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python 3.9 or newer was not found.
  echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH",
  echo then run this file again.
  pause
  exit /b 1
)

rem Local only (no firewall prompt). Source code is read from the sources\ snapshot
rem automatically, because the build-host paths do not exist here.
set "ATLAS_HOST=127.0.0.1"
set "ATLAS_OPEN=1"
echo Starting model_atlas on http://127.0.0.1:%PORT%/
echo Close this window or press Ctrl+C to stop.
%PY% webui\serve.py %PORT%
if errorlevel 1 pause
endlocal

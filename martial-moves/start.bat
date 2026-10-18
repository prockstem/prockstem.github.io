@echo off
setlocal
cd /d "%~dp0"
title Martial Moves

rem ---- find Python 3.10 or newer
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=python"
if not defined PY goto nopython

rem ---- first run: create a private Python environment in .venv
if exist ".venv\Scripts\python.exe" goto haveenv
echo Setting up Martial Moves for the first time. This takes a minute or two...
%PY% -m venv .venv
if errorlevel 1 goto venvfail
:haveenv
set "VPY=.venv\Scripts\python.exe"

rem ---- install requirements if missing or changed
fc /b requirements.txt .venv\requirements.installed >nul 2>nul
if not errorlevel 1 goto installed
echo Installing required packages...
"%VPY%" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto pipfail
copy /y requirements.txt .venv\requirements.installed >nul
:installed

rem ---- skip Streamlit's one-time "enter your email" question
if exist "%USERPROFILE%\.streamlit\credentials.toml" goto run
mkdir "%USERPROFILE%\.streamlit" >nul 2>nul
> "%USERPROFILE%\.streamlit\credentials.toml" echo [general]
>> "%USERPROFILE%\.streamlit\credentials.toml" echo email = ""

:run
echo.
echo Starting Martial Moves. Your browser will open in a moment.
echo Keep this window open while you use the app. Close it to quit.
echo.
"%VPY%" -m streamlit run app.py --server.headless false
if errorlevel 1 goto runfail
goto end

:nopython
echo.
echo Python 3.10 or newer was not found.
echo 1. Download it from https://www.python.org/downloads/
echo 2. In the installer, tick "Add python.exe to PATH", then click Install Now.
echo 3. Double-click start.bat again.
echo.
pause
goto end

:venvfail
echo.
echo Could not create the Python environment in the .venv folder.
echo Delete the .venv folder if it exists and try again.
pause
goto end

:pipfail
echo.
echo Installing packages failed. Check your internet connection and try again.
pause
goto end

:runfail
echo.
echo Martial Moves stopped with an error (see above).
pause

:end
endlocal

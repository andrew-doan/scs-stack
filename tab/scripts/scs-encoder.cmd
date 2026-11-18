@echo off
rem SCS.2 video encoder - double-click this on Windows.
rem
rem It makes sure Node and ffmpeg are available (downloading them into
rem %USERPROFILE%\.scs2-encoder if this computer does not already have
rem them, no installer and no admin rights), asks once for the worker
rem address and the encoder key, and then runs encoder.mjs from this
rem same folder.
rem
rem Run it again any time. Pass --reconfigure to be asked for the
rem address and the key again.

setlocal
set "NODE_VERSION=v22.11.0"
set "HOME_DIR=%USERPROFILE%\.scs2-encoder"
set "OLD_CONFIG=%HOME_DIR%\config"
set "API_FILE=%HOME_DIR%\address"
set "KEY_FILE=%HOME_DIR%\key"

rem (a) this script's own folder, so encoder.mjs beside it is found
set "HERE=%~dp0"
set "RUNNER=%HERE%encoder.mjs"

echo SCS.2 video encoder
echo.

if not exist "%RUNNER%" (
  set "WHY=encoder.mjs is not in this folder. Keep scs-encoder.cmd and encoder.mjs together."
  goto fail
)

if not exist "%HOME_DIR%" mkdir "%HOME_DIR%"
if not exist "%HOME_DIR%\bin" mkdir "%HOME_DIR%\bin"

rem This launcher is for 64-bit Intel and AMD machines, which is all of
rem them bar Windows on ARM.
if /i not "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
  if /i not "%PROCESSOR_ARCHITEW6432%"=="AMD64" (
    set "WHY=This launcher is for 64-bit Windows. On Windows on ARM, install Node and ffmpeg yourself and run: node encoder.mjs"
    goto fail
  )
)

rem ---------- (b) Node ----------

set "NODE_BIN="
node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>&1
if not errorlevel 1 (
  set "NODE_BIN=node"
  echo Using the Node already on this computer.
  goto have_node
)

set "OWN_NODE=%HOME_DIR%\node\node-%NODE_VERSION%-win-x64\node.exe"
if exist "%OWN_NODE%" (
  set "NODE_BIN=%OWN_NODE%"
  echo Using the Node downloaded here earlier.
  goto have_node
)

echo Downloading Node %NODE_VERSION% ^(about 30 MB, once^).
if not exist "%HOME_DIR%\node" mkdir "%HOME_DIR%\node"
curl.exe -fL --progress-bar -o "%HOME_DIR%\node\node.zip" "https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip"
if errorlevel 1 (
  set "WHY=Could not download Node. Install it from nodejs.org and run this again."
  goto fail
)
tar.exe -xf "%HOME_DIR%\node\node.zip" -C "%HOME_DIR%\node"
if errorlevel 1 (
  set "WHY=The Node download would not unpack. Delete %HOME_DIR%\node and try again."
  goto fail
)
del /q "%HOME_DIR%\node\node.zip" >nul 2>&1
if not exist "%OWN_NODE%" (
  set "WHY=Node did not unpack where it was expected. Delete %HOME_DIR%\node and try again."
  goto fail
)
set "NODE_BIN=%OWN_NODE%"
echo Node is ready.

:have_node

rem ---------- (c) ffmpeg and ffprobe ----------

set "FFMPEG="
set "FFPROBE="
where ffmpeg >nul 2>&1
if errorlevel 1 goto need_ffmpeg
where ffprobe >nul 2>&1
if errorlevel 1 goto need_ffmpeg
set "FFMPEG=ffmpeg"
set "FFPROBE=ffprobe"
echo Using the ffmpeg already on this computer.
goto have_ffmpeg

:need_ffmpeg
rem dir /b /s lists only files that are really there, which a bare
rem for /r pattern does not
for /f "usebackq delims=" %%f in (`dir /b /s "%HOME_DIR%\bin\ffmpeg.exe" 2^>nul`) do set "FFMPEG=%%f"
for /f "usebackq delims=" %%f in (`dir /b /s "%HOME_DIR%\bin\ffprobe.exe" 2^>nul`) do set "FFPROBE=%%f"
if not "%FFMPEG%"=="" if not "%FFPROBE%"=="" (
  echo Using the ffmpeg downloaded here earlier.
  goto have_ffmpeg
)

echo Downloading ffmpeg ^(about 90 MB, once^).
curl.exe -fL --progress-bar -o "%HOME_DIR%\bin\ffmpeg.zip" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
if errorlevel 1 (
  set "WHY=Could not download ffmpeg. Install it yourself with: winget install ffmpeg"
  goto fail
)
tar.exe -xf "%HOME_DIR%\bin\ffmpeg.zip" -C "%HOME_DIR%\bin"
if errorlevel 1 (
  set "WHY=The ffmpeg download would not unpack. Install it yourself with: winget install ffmpeg"
  goto fail
)
del /q "%HOME_DIR%\bin\ffmpeg.zip" >nul 2>&1
for /f "usebackq delims=" %%f in (`dir /b /s "%HOME_DIR%\bin\ffmpeg.exe" 2^>nul`) do set "FFMPEG=%%f"
for /f "usebackq delims=" %%f in (`dir /b /s "%HOME_DIR%\bin\ffprobe.exe" 2^>nul`) do set "FFPROBE=%%f"
if "%FFMPEG%"=="" (
  set "WHY=ffmpeg did not unpack where it was expected. Install it yourself with: winget install ffmpeg"
  goto fail
)
if "%FFPROBE%"=="" (
  set "WHY=ffprobe did not unpack where it was expected. Install it yourself with: winget install ffmpeg"
  goto fail
)
echo ffmpeg is ready.

:have_ffmpeg

rem ---------- (d) the worker address and the key ----------
rem
rem Each answer gets a file of its own holding that value and nothing
rem else, and the value is written and read whole. An earlier version
rem put both in one KEY=VALUE file written with echo. cmd reads an
rem unquoted echo as a command line, so ampersands, pipes, redirection
rem arrows and carets in a key were taken as syntax and lost, and
rem for /f stopped reading a line at a semicolon on the way back out.
rem The key then worked in the run that typed it and was refused in
rem every run after that.

set "RECONFIGURE=%RECONFIGURE%"
if /i "%~1"=="--reconfigure" set "RECONFIGURE=1"
if /i "%~2"=="--reconfigure" set "RECONFIGURE=1"

if "%RECONFIGURE%"=="1" goto ask
if exist "%OLD_CONFIG%" goto old_format
if not exist "%API_FILE%" goto ask
if not exist "%KEY_FILE%" goto ask
goto load

:old_format
del /q "%OLD_CONFIG%" >nul 2>&1
echo The settings on this computer were saved in an older format that could
echo store the key wrongly, so they need typing once more.

:ask
del /q "%KEY_FILE%" >nul 2>&1
echo.
echo Two questions, once. They are kept in %HOME_DIR% on this computer.
set "DEFAULT_API=https://files.scs.andyrew.space"
set "TYPED_API="
set /p "TYPED_API=Worker address [%DEFAULT_API%]: "
if not defined TYPED_API set "TYPED_API=%DEFAULT_API%"
rem set /p writes its prompt with no line ending and, reading from nul,
rem leaves the variable alone: the file ends up holding the value alone
> "%API_FILE%" <nul set /p "=%TYPED_API%"

rem PowerShell asks for the key without showing it and writes the file
rem itself, so the key never passes through a cmd command line
set "SCS_KEY_FILE=%KEY_FILE%"
powershell -NoProfile -Command "$s = Read-Host -AsSecureString 'Encoder key'; $k = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); if ($k) { [IO.File]::WriteAllText($env:SCS_KEY_FILE, $k, (New-Object Text.UTF8Encoding $false)) }" 2>nul
set "SCS_KEY_FILE="
set "KEY_SAVED="
if exist "%KEY_FILE%" for %%f in ("%KEY_FILE%") do if not "%%~zf"=="0" set "KEY_SAVED=1"
if defined KEY_SAVED goto saved

echo The key will show as you type it.
set "TYPED_KEY="
set /p "TYPED_KEY=Encoder key: "
if not defined TYPED_KEY (
  set "WHY=No key, no encoding. Ask the tab team for the encoder key and run this again."
  goto fail
)
> "%KEY_FILE%" <nul set /p "=%TYPED_KEY%"
set "TYPED_KEY="

:saved
rem the key is in there, so keep the file to this account
icacls "%KEY_FILE%" /inheritance:r /grant:r "%USERNAME%:F" >nul 2>&1
echo Saved.

:load
rem both are read back from disk even on the run that saved them, so a
rem value that did not survive is caught now rather than next time
set "TAB_API="
set "ENCODER_KEY="
if not exist "%API_FILE%" goto bad_config
if not exist "%KEY_FILE%" goto bad_config
< "%API_FILE%" set /p "TAB_API="
< "%KEY_FILE%" set /p "ENCODER_KEY="
if not defined TAB_API goto bad_config
if not defined ENCODER_KEY goto bad_config

rem ---------- (e) run it ----------

echo.
"%NODE_BIN%" "%RUNNER%"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo The encoder stopped with an error.
  pause
)
endlocal
exit /b 0

:bad_config
set "WHY=The saved settings could not be read. Run this again with --reconfigure."
goto fail

:fail
echo.
echo %WHY%
echo.
pause
endlocal
exit /b 1

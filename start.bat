@echo off
REM Opens the Live2D demo in your browser.
REM The page CANNOT be opened as a file (file://.../index.html) - browsers block ES
REM modules and fetch() there, so it must be served over HTTP. This script starts
REM the local static server if it is not already running, then opens the page.
REM serve.py is HTTP/1.1 keep-alive + threaded, which is what makes the page load in
REM about a second instead of ten.

cd /d "%~dp0"

powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/index.html -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting local server on http://127.0.0.1:8000 ...
  start "" /b python serve.py
  timeout /t 2 /nobreak >nul
)

start "" http://127.0.0.1:8000/index.html

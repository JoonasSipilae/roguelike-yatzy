@echo off
cd /d "%~dp0"
start "DICE-GAME server (keep this window open - closing it stops the game)" cmd /c "python -m http.server 8791"
timeout /t 1 /nobreak >nul
start "" http://localhost:8791/index.html

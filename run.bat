@echo off
setlocal enabledelayedexpansion
title RebarAnalysis Server

echo =========================
echo       RebarAnalysis
echo =========================
echo.

:: Check dependencies
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js to continue.
    pause
    exit /b 1
)

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed. Please install Python 3 to continue.
    pause
    exit /b 1
)

:: 1. Setup Environment Variables
if not exist "backend\.env" (
    echo [SETUP] First time setup: Please enter your credentials.
    echo.
    set /p GEMPRISM_API_KEY="GemPrism Gateway Token (e.g. gp_live_...) : "
    set /p SENDER_EMAIL="Sender Email Address (Gmail)              : "
    set /p SENDER_PASS="Sender App Password (16 chars)            : "

    echo GEMPRISM_API_KEY=!GEMPRISM_API_KEY!> backend\.env
    echo SENDER_EMAIL=!SENDER_EMAIL!>> backend\.env
    echo SENDER_PASS=!SENDER_PASS!>> backend\.env
    echo.
    echo [SUCCESS] .env file created successfully!
)

:: 2. Setup Backend Virtual Environment
if not exist "backend\venv\" (
    echo [SETUP] Setting up Python virtual environment...
    python -m venv backend\venv
    call backend\venv\Scripts\activate.bat
    pip install -r backend\requirements.txt
    call deactivate
    echo [SUCCESS] Backend setup complete!
)

:: 3. Setup Frontend Dependencies
if not exist "frontend\node_modules\" (
    echo [SETUP] Installing frontend dependencies...
    cd frontend
    call npm install
    cd ..
    echo [SUCCESS] Frontend setup complete!
)

echo.
echo [INFO] Starting servers... Press Ctrl+C to stop both.
:: Using npx concurrently to run both processes cleanly in one window
npx --yes concurrently -c "blue,green" -n "BACKEND,FRONTEND" "call backend\venv\Scripts\activate.bat && cd backend\src && python app.py" "cd frontend && npm start"
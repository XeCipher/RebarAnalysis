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

:: 1. Setup Backend Environment Variables
if not exist "backend\.env" (
    echo [SETUP] Backend Setup: Please enter your Email credentials.
    echo.
    set /p SENDER_EMAIL="Sender Email Address (Gmail)              : "
    set /p SENDER_PASS="Sender App Password (16 chars)            : "

    echo SENDER_EMAIL=!SENDER_EMAIL!> backend\.env
    echo SENDER_PASS=!SENDER_PASS!>> backend\.env
    echo.
    echo [SUCCESS] backend\.env file created successfully!
)

:: 2. Setup Frontend Environment Variables
if not exist "frontend\src\environments\environment.ts" (
    echo [SETUP] Frontend Setup: Please enter your Public Keys.
    echo.
    if not exist "frontend\src\environments" mkdir "frontend\src\environments"
    
    set /p GEMPRISM_API_KEY="GemPrism Gateway Token (e.g. gp_live_...) : "
    
    echo export const environment = {> frontend\src\environments\environment.ts
    echo   production: false,>> frontend\src\environments\environment.ts
    echo   gemprismApiKey: '!GEMPRISM_API_KEY!',>> frontend\src\environments\environment.ts
    echo   gemprismBaseUrl: 'https://gemprism.vercel.app',>> frontend\src\environments\environment.ts
    echo   apiBaseUrl: 'http://localhost:5000'>> frontend\src\environments\environment.ts
    echo };>> frontend\src\environments\environment.ts
    echo.
    echo [SUCCESS] frontend environment.ts created successfully!
)

:: 3. Setup Backend Virtual Environment
if not exist "backend\venv\" (
    echo [SETUP] Setting up Python virtual environment...
    python -m venv backend\venv
    call backend\venv\Scripts\activate.bat
    pip install -r backend\requirements.txt
    call deactivate
    echo [SUCCESS] Backend setup complete!
)

:: 4. Setup Frontend Dependencies
if not exist "frontend\node_modules\" (
    echo [SETUP] Installing frontend dependencies...
    cd frontend
    call npm install
    cd ..
    echo [SUCCESS] Frontend setup complete!
)

echo.
echo [INFO] Starting servers... Press Ctrl+C to stop both.
:: Using npx concurrently to run both processes and a third to wait & open the browser
npx --yes concurrently -c "blue,green,yellow" -n "BACKEND,FRONTEND,BROWSER" "call backend\venv\Scripts\activate.bat && cd backend\src && python app.py" "cd frontend && npm start" "npx --yes wait-on http://localhost:4200 && start http://localhost:4200"
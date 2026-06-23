@echo off
echo.
echo  ========================================
echo   AI Mind Map - One-Click Setup
echo   Token Optimization MCP Server
echo  ========================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from: https://nodejs.org
    echo Minimum version: 18.0.0
    pause
    exit /b 1
)

:: Check Node version
for /f "tokens=1 delims=v" %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js found: v%NODE_VER%

:: Install dependencies
echo.
echo [1/3] Installing dependencies...
call npm install --legacy-peer-deps
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install failed!
    pause
    exit /b 1
)
echo [OK] Dependencies installed

:: Build TypeScript
echo.
echo [2/3] Building TypeScript...
call npx tsc
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build failed!
    pause
    exit /b 1
)
echo [OK] Build complete

:: Get absolute path
set MINDMAP_PATH=%~dp0dist\index.js
echo.
echo [3/3] Setup complete!
echo.
echo  ========================================
echo   INSTALLATION SUCCESSFUL!
echo  ========================================
echo.
echo  Server path: %MINDMAP_PATH%
echo.
echo  Next: Add this MCP server to your AI agent.
echo  See README.md for configuration instructions.
echo.
echo  Quick test:
echo    node "%MINDMAP_PATH%" --project-root "YOUR_PROJECT_PATH"
echo.
pause

@echo off
cd /d "%~dp0"
echo ==================================================
echo    Deploying the Convex backend (convex/ folder)
echo ==================================================
echo.
call npx convex deploy -y
echo.
echo --------------------------------------------------
echo  Done. (The website itself is deployed separately with Deploy.bat)
echo --------------------------------------------------
pause

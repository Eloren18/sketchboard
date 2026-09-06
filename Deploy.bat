@echo off
cd /d "%~dp0"
echo ==================================================
echo    Sending your Sketchboard changes to GitHub...
echo ==================================================
echo.
git add -A
git commit -m "Update %DATE% %TIME%"
echo.
echo Syncing with GitHub...
git pull --rebase origin main
git push -u origin main
echo.
echo --------------------------------------------------
echo  Pushed. A GitHub Action now builds and publishes
echo  the site automatically (takes about two minutes):
echo  https://eloren18.github.io/sketchboard/
echo.
echo  Watch it run:  Actions tab of your GitHub repo.
echo  (If it says "Everything up-to-date", there was
echo   nothing new to publish.)
echo --------------------------------------------------
echo.
echo You can close this window.
pause

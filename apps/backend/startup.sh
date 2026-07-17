#!/bin/bash
# Azure App Service startup script for Node.js
echo "Starting Ekatra Backend..."
cd /home/site/wwwroot
node dist/index.js

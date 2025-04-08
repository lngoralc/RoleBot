#!/bin/bash
# initialize nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
export NVM_BIN=/home/pi/.nvm/versions/node/v18.20.8/bin # unsure if needed, added just in case
export NVM_INC=/home/pi/.nvm/versions/node/v18.20.8/include/node # unsure if needed, added just in case

# actually start the bot
cd /home/pi/RoleBot && /home/pi/.nvm/versions/node/v18.20.8/bin/yarn start

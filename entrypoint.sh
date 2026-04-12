#!/bin/bash

# dump ENV variables to /etc/environment so cron can inherit them
printenv | grep -v "no_proxy" >> /etc/environment
crontabContent=$(printf "%s root bash -l -c 'java -jar /notion-keeper.jar' >> /var/log/cron.log 2>&1\n" "$SCHEDULING_CONFIG")
if ! echo "$crontabContent" | crontab > /dev/null 2>&1; then
    echo "The env variable SCHEDULING_CONFIG does not contain a proper CRON syntax. Value was: $SCHEDULING_CONFIG"
    exit 1
fi
echo "Scheduling backup with cron syntax '$SCHEDULING_CONFIG'"
echo "Using timezone '$TZ'"
echo "$crontabContent" > /etc/cron.d/notion-keeper
cron
tail -f /var/log/cron.log
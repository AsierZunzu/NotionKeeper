FROM maven:3-eclipse-temurin-25 AS build

COPY ./pom.xml /usr/src/mymaven/pom.xml
COPY ./checkstyle.xml /usr/src/mymaven/checkstyle.xml
COPY ./src /usr/src/mymaven/src
WORKDIR /usr/src/mymaven

RUN mvn clean install

FROM eclipse-temurin:25-jdk

WORKDIR /

RUN mkdir /downloads
RUN chmod 755 /downloads

COPY --from=build /usr/src/mymaven/target/notion-keeper-1.0-SNAPSHOT.jar /notion-keeper.jar

RUN apt-get update && apt-get install -y cron --no-install-recommends && rm -rf /var/cache/apt/archives /var/lib/apt/lists/*.
RUN touch /etc/cron.d/notion-keeper \
   chmod 0644 /etc/cron.d/notion-keeper \
   crontab /etc/cron.d/notion-keeper
RUN touch /var/log/cron.log

COPY ./entrypoint.sh /
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]

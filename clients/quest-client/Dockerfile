# Build image for the Quest panel client: JDK 17, Android command-line tools, platform 34, Gradle 8.7.
FROM eclipse-temurin:17-jdk
RUN apt-get update && apt-get install -y --no-install-recommends unzip curl && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp \
 && curl -fsSLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
 && unzip -q tools.zip && mv cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm tools.zip \
 && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools" > /dev/null
RUN cd /tmp && curl -fsSLo gradle.zip https://services.gradle.org/distributions/gradle-8.7-bin.zip \
 && unzip -q gradle.zip -d /opt && rm gradle.zip
ENV PATH=/opt/gradle-8.7/bin:$ANDROID_HOME/build-tools/34.0.0:$PATH

FROM gradle:8.13-jdk17
USER root
ENV ANDROID_HOME=/opt/android-sdk
RUN curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o /tmp/sdk.zip \
 && echo '7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee  /tmp/sdk.zip' | sha256sum -c - \
 && mkdir -p /opt/android-sdk/cmdline-tools \
 && unzip -q /tmp/sdk.zip -d /tmp/sdk \
 && mv /tmp/sdk/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
 && rm /tmp/sdk.zip \
 && yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
 && /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager 'platforms;android-36' 'build-tools;35.0.0' 'platform-tools'
WORKDIR /project

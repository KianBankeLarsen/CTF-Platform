FROM alpine:3.21.0

# Install necessary packages
RUN apk add --update dumb-init openssh shadow

# Create initial user and disable password
RUN useradd -m -p '*' bastion

# Ensure SSH configuration directory exists
RUN mkdir -p /etc/ssh/sshd_config.d/

# Copy init script and SSH bastion config
COPY init.sh /bastion/init.sh
COPY sshd_bastion.conf /etc/ssh/sshd_config.d/

# Set entry point and command
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/bastion/init.sh"]
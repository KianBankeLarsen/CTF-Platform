FROM ctfd/ctfd:3.7.7

COPY ctfd/requirements.txt .
RUN pip install -r requirements.txt

COPY challenges/frontend/container_challenges /opt/CTFd/CTFd/plugins/container_challenges
COPY ctfd/oidc /opt/CTFd/CTFd/plugins/ctfd_oidc

RUN pip install --no-cache-dir -r /opt/CTFd/CTFd/plugins/ctfd_oidc/requirements.txt
FROM registry.fedoraproject.org/fedora:44
RUN dnf install -y --setopt=install_weak_deps=False chromium google-noto-sans-fonts dejavu-sans-fonts procps-ng && dnf clean all

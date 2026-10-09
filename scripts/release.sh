#!/bin/sh
# Gera a imagem para a VPS (linux/amd64) e envia ao Docker Hub.
#   ./scripts/release.sh v1
set -e
TAG="${1:?Uso: ./scripts/release.sh <versão, ex.: v1>}"
IMAGE="${IMAGE_REPO:-allysonassuncao/mavi-agentes}"
npm run typecheck
npm test
docker buildx build --platform linux/amd64 -t "$IMAGE:$TAG" --push .
echo "Publicada: $IMAGE:$TAG — atualize a stack no Portainer (variável IMAGE ou a tag)."

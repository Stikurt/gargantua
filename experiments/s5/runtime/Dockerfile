FROM python@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
    HOME=/tmp HF_HOME=/tmp/huggingface MPLCONFIGDIR=/tmp/matplotlib
COPY wheels /wheels
COPY requirements.lock wheel-lock.json /runtime-lock/
COPY smoke.py /runtime-lock/smoke.py
RUN --network=none python -m pip install --no-index --no-cache-dir --only-binary=:all: --require-hashes --find-links=/wheels -r /runtime-lock/requirements.lock && \
    python -m pip check && \
    rm -rf /wheels
USER 1000:1000
WORKDIR /tmp
CMD ["python"]

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ARENA_HERO_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY . .

RUN useradd --create-home --uid 10001 tactic \
    && mkdir -p /data \
    && chown -R tactic:tactic /app /data
USER tactic

VOLUME ["/data"]
CMD ["python", "-u", "-m", "arena_hero_tactic.tactic.engine"]
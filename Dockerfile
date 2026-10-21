FROM python:3.12-alpine
WORKDIR /app
COPY live_direct /app/live_direct
RUN chmod -R a+rX /app/live_direct
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).read()"]
ENTRYPOINT ["python3", "-m", "live_direct.app"]

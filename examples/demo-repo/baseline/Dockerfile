FROM python:3.12.7-slim-bookworm

RUN useradd --create-home --uid 10001 app
WORKDIR /home/app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

USER 10001
EXPOSE 5000
CMD ["python", "-m", "flask", "--app", "app.server", "run", "--host", "0.0.0.0"]

FROM python:latest

RUN apt-get update && apt-get install curl

WORKDIR /app
ADD requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app

EXPOSE 5000
CMD ["python", "-m", "flask", "--app", "app.server", "run", "--host", "0.0.0.0"]

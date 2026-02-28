FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN useradd --system --no-create-home --shell /bin/false uavchum

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py gunicorn.conf.py ./
COPY static/ static/
COPY templates/ templates/

USER uavchum

EXPOSE 5555

CMD ["gunicorn", "-c", "gunicorn.conf.py", "--bind", "0.0.0.0:5555", "app:app"]

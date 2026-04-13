## Setup / prod

I have set this up in prod with nginx, with fastapi running in a screen and venv, a bit ugly but works


run

>npm run build

>uvicorn main:app --host 0.0.0.0 --port 8000 --reload

the dist folder is then mirrored to /var/www/dist which is served by nginx


server {
    listen 80;
    root /var/www/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

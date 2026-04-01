FROM python:3.9-slim

WORKDIR /app

RUN pip install --no-cache-dir ortools

COPY lane_solver.py solver_api.py weekly_solver_v4.py ./

ENV PORT=8080
EXPOSE 8080

CMD ["python3", "solver_api.py"]

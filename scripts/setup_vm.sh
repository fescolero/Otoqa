#!/bin/bash
set -e

echo "=== Installing Python 3.9 ==="
sudo apt-get update
sudo apt-get install -y python3.9 python3.9-venv 2>/dev/null || {
    # If 3.9 not in apt, compile from source
    echo "Building Python 3.9 from source..."
    sudo apt-get install -y build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libffi-dev wget
    cd /tmp
    wget -q https://www.python.org/ftp/python/3.9.18/Python-3.9.18.tgz
    tar xzf Python-3.9.18.tgz
    cd Python-3.9.18
    ./configure --enable-optimizations --prefix=/usr/local 2>&1 | tail -3
    make -j$(nproc) 2>&1 | tail -3
    sudo make altinstall 2>&1 | tail -3
}

echo "=== Setting up solver with Python 3.9 ==="
sudo pkill -f solver_api 2>/dev/null || true
sleep 1

# Create venv with Python 3.9
sudo /usr/local/bin/python3.9 -m venv /opt/solver/venv39 || sudo python3.9 -m venv /opt/solver/venv39
sudo /opt/solver/venv39/bin/pip install ortools 2>&1 | tail -3

echo "=== Starting solver ==="
cd /opt/solver
sudo nohup /opt/solver/venv39/bin/python solver_api.py > /tmp/solver.log 2>&1 &
sleep 3
curl -s http://localhost:8080/health
echo ""
/opt/solver/venv39/bin/python --version
echo "=== Done ==="

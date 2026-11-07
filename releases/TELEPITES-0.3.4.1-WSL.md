# WSL telepítés: Marveen Codex Bridge 0.3.4.1 candidate

1. Töltsd le az archívumot, SHA-256 és telepítő fájlt a Windows Letöltések mappájába.
2. Győződj meg arról, hogy a 0.3.4 szolgáltatás egészséges, és Bélának nincs aktív Codex-feladata.
3. WSL Ubuntu alatt:

```bash
mkdir -p ~/bridge-upgrade
cd ~/bridge-upgrade
cp /mnt/c/Users/kisss/Downloads/Marveen-Codex-Bridge-v0.3.4.1-candidate.tar.gz .
cp /mnt/c/Users/kisss/Downloads/Marveen-Codex-Bridge-v0.3.4.1-candidate.tar.gz.sha256 .
cp /mnt/c/Users/kisss/Downloads/install-Marveen-Codex-Bridge-v0.3.4.1-candidate.sh .
sha256sum -c Marveen-Codex-Bridge-v0.3.4.1-candidate.tar.gz.sha256
curl -fsS http://127.0.0.1:3431/readyz; echo
bash install-Marveen-Codex-Bridge-v0.3.4.1-candidate.sh ./Marveen-Codex-Bridge-v0.3.4.1-candidate.tar.gz
```

4. Ha valamelyik ellenőrzés hibázik, ne kapcsold ki az ellenőrzést. A telepítő a 0.3.4 verziót próbálja visszaállítani.
5. Sikeres aktiválás után ellenőrizd a `readyz` verzióját, illetve hogy `turnTimeoutMs` és `runtimeLeaseMs` egyaránt **2700000**.
6. Végezz kontrollált éles feladattesztet; a mentést őrizd meg.

**Figyelem:** a 45 perc nem garantálja, hogy egy hosszú feladat mindenképp sikeres lesz.

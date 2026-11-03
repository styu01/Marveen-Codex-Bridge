# Marveen Codex Bridge 0.3.4 candidate

A teljes forrás a repository gyökérkönyvtárában található. A kiadási fájlok:

- [Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz](Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz) – sértetlenség-ellenőrzött teljes forrásarchívum.
- [Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz.sha256](Marveen-Codex-Bridge-v0.3.4-candidate.tar.gz.sha256) – az archívum SHA-256 értéke.
- [install-Marveen-Codex-Bridge-v0.3.4-candidate-r2.sh](install-Marveen-Codex-Bridge-v0.3.4-candidate-r2.sh) – **a javított, használható telepítő**.
- [TELEPITES-0.3.4-WSL.md](TELEPITES-0.3.4-WSL.md) – telepítési útmutató.
- [ELLENORZES-Marveen-Codex-Bridge-0.3.4.md](ELLENORZES-Marveen-Codex-Bridge-0.3.4.md) – kiadás előtti műszaki ellenőrzés.

**Telepítés előtti kontroll:** folyamatban lévő Codex-feladat nélkül; a 0.3.3 release és annak mentése maradjon meg.
Az eredeti `install-Marveen-Codex-Bridge-v0.3.4-candidate.sh` változat hibás archívumgyökér-ellenőrzése miatt **nem ajánlott**.

**2026-11-03 WSL-ellenőrzés:** 151/151 automatikus teszt sikeres;
`/readyz` = `0.3.4 / ready`, lease = 1 800 000 ms, modell = `gpt-6.1-sol / medium`.
A hosszú, valós Marveen → Codex → Marveen E2E tesztet külön kell igazolni.

Az archívum SHA-256 értéke:

```text
6b2f3d9e8a6670848eb16691cd60a927de3e838374b40a9873d6a33377ccb16f
```

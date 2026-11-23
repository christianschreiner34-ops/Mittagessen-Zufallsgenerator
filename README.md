# Mittagsrad

Webseite fürs Office in Heilbronn: Kollegen tragen Restaurants in eine gemeinsame Liste ein, mittags entscheidet ein Glücksrad.

## Was die Seite kann

- Anmeldung per E-Mail-Link, nur für Adressen, die ein Admin freigegeben hat
- Restaurants eintragen und bearbeiten (Kategorie, Preis, Fußweg, vegetarisch, Adresse, Link, Notizen)
- Glücksrad mit Filtern; was an den letzten Essenstagen gezogen wurde, fliegt automatisch raus (am Montag ist „gestern" der Freitag)
- Verlauf der Ziehungen und die häufigsten Ziele
- Admins geben Kollegen frei, löschen Restaurants und entfernen Ziehungen

## Aufbau

Drei Dateien (`index.html`, `style.css`, `app.js`), kein Build-Schritt. Daten und Anmeldung laufen über Supabase (Projekt `mittagessen-gluecksrad`, Frankfurt). Die Zugriffsregeln stehen in der Datenbank (Row Level Security), deshalb darf der öffentliche Schlüssel in `app.js` stehen. Das Datenbankschema liegt in `supabase/schema.sql`.

Lokal testen: `npx serve .` und die angezeigte Adresse öffnen.

Die alte Version liegt in der Git-Historie (Commit fd0572f).

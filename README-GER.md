# Ametras Fast Import — Eigenstaendiger Desktop-Client

Sprache: **[EN](README.md)** | **[DE](README-GER.md)**

Ametras Fast Import ist eine **eigenstaendige Desktop-Anwendung** fuer den Import
grosser CSV-Dateien in Odoo. Die App laeuft als Electron-Anwendung auf Ihrem Computer
und verbindet sich direkt ueber das Netzwerk mit einem beliebigen Odoo 16+-Server.

> **Dies ist kein Odoo-Addon.** Auf Ihrem Odoo-Server wird nichts installiert. Die App
> laeuft vollstaendig auf Ihrem Desktop und kommuniziert mit Odoo ueber die
> Standard-JSON-RPC-API.

## Was Sie benoetigen

- Die Ametras Fast Import Desktop-App auf Ihrem Computer
- Zugriff auf einen Odoo 16+-Server (Cloud oder On-Premise)
- Einen Odoo-Benutzeraccount mit Import-Berechtigungen fuer die Zielmodelle
- CSV-Dateien fuer den Import

## Installation

Installieren Sie das App-Paket, das Ihr Team bereitstellt:

- **macOS**: `.dmg`
- **Windows**: `.exe`
- **Linux**: `.AppImage`

Die App ist aktuell **nicht von Apple/Microsoft code-signiert**, daher koennen macOS und
Windows den ersten Start blockieren.

### macOS: "App can't be opened" / "developer cannot be verified"

Verwenden Sie eine dieser Methoden:

1. Im Finder die App suchen, dann **Control-Klick** auf die App und **Open** waehlen.
2. Im Warn-Dialog erneut **Open** klicken.

Falls sie weiterhin blockiert ist:

1. **System Settings** oeffnen.
2. Zu **Privacy & Security** gehen.
3. Im Security-Bereich die blockierte App-Meldung suchen.
4. **Open Anyway** klicken.
5. Mit **Open** bestaetigen.

### Windows: "Windows protected your PC"

1. Installer oder App starten.
2. Im SmartScreen-Dialog auf **More info** klicken.
3. **Run anyway** klicken.
4. Installation fortsetzen.

## Erster Login

Im Login-Bildschirm:

1. **Server Host** eingeben (Beispiel: `mycompany.odoo.com` oder `192.168.1.100/odoo`).
2. Optional **Port & SSL** oeffnen und anpassen.
3. **Database**, **Username** und **Password** eingeben.
4. **Connect** klicken.

Tipps:

- Sie koennen **Saved Connections** speichern und wiederverwenden.
- Eine gespeicherte Verbindung koennen Sie mit dem `x`-Button entfernen.

## Import-Ablauf

### 1) `Import` oeffnen

- Zu **Import** gehen.
- Dateien ueber **Add Files** hinzufuegen oder CSV-Dateien per Drag-and-Drop ablegen.

### 2) Profil und Einstellungen waehlen

Oben in Import:

- **Profile tab**: bestehendes Import-Profil auswaehlen (optional).
- **Settings tab**: Import-Verhalten konfigurieren (siehe Abschnitt Einstellungen
  unten).

### 3) Jede Datei konfigurieren

Fuer jede hochgeladene Datei:

1. **CSV Preview** pruefen.
2. **Target Model** auswaehlen.
3. **Field Mappings** pruefen und anpassen.

Wenn die Zuordnungen passen, **Start Import** klicken.

### 4) In `Run` ueberwachen

Waehrend des Imports koennen Sie:

- **Pause** / **Resume**
- **Skip File**
- **Abort**

Fortschritt, Erfolgs- und Fehleranzahl werden pro Datei in Echtzeit angezeigt.

### 5) In `Result` auswerten

Nach dem Import zeigt die Result-Seite:

- Gesamtanzahl Zeilen
- Erfolgreiche Zeilen
- Fehlgeschlagene Zeilen
- Dauer

Bei Fehlern koennen Sie:

- **Download Unified Error Log (CSV)**
- **Download Failed Rows ZIP (.csv)**
- **Retry Failed Rows**

## Einstellungen

In `Import -> Settings`:

- **Batch Size**: Anzahl Zeilen pro Request-Batch.
- **Encoding**: CSV-Textkodierung (`UTF-8`, `UTF-8 BOM`, `Latin-1`, `CP1252`).
- **Delimiter**: Komma, Semikolon, Tab oder Auto-Erkennung.
- **Skip header row**: standardmaessig aktiv fuer uebliche CSV-Dateien.

Die Standardwerte sind fuer die meisten Importe geeignet. Passen Sie **Batch Size** nur
an, wenn Sie ein anderes Performance-Verhalten benoetigen.

## Profile

Profile helfen dabei, Import-Konfigurationen wiederzuverwenden (Modellzuordnung,
Feldzuordnung, Reihenfolge, Einstellungen).

### In `Import` erstellen oder aktualisieren

- **Save as New Profile**: aktuelle Konfiguration als neues Profil speichern.
- **Update Profile**: das ausgewaehlte Profil mit den aktuellen Aenderungen
  aktualisieren.

### In `Profiles` verwalten

Auf der **Profiles**-Seite koennen Sie:

- **Import Local Profile (ZIP)**
- **Export Profile (ZIP)**
- Profil **Delete**

Wichtig:

- Profil-Dateiabgleich basiert auf Dateinamen.
- Wenn benoetigte Dateien fehlen, zeigt die App eine Warnung.
- Zusaetzliche Dateien, die nicht im Profil stehen, koennen trotzdem importiert werden.

## Fehlerbehebung

- **Verbindung schlaegt fehl**: Host, Port, SSL, Datenbank, Username und Password erneut
  pruefen. Login zuerst in der normalen Odoo-Weboberflaeche testen.
- **Viele Zeilenfehler**: Delimiter und Encoding pruefen. Feldzuordnungen und
  Pflichtfelder erneut pruefen. Fehlgeschlagene Zeilen exportieren und nur korrigierte
  Zeilen erneut importieren.
- **Profil wird nicht wie erwartet angewendet**: Sicherstellen, dass CSV-Dateinamen zu
  den erwarteten Profil-Dateinamen passen. Mapping und Import-Reihenfolge in der
  Profiles-Seite pruefen.

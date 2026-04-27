# Ametras Fast Import fuer Odoo (Deutsch)

Sprache: **[EN](README.md)** | **[DE](README-GER.md)**

Ametras Fast Import hilft Ihnen dabei, grosse CSV-Dateien in Odoo zu importieren - mit einer gefuehrten UI, wiederverwendbaren Profilen und Fortschrittsanzeige.

Dieses README richtet sich an **Endanwender** (Installation und taegliche Nutzung), nicht an die interne Architektur.

## Was Sie benoetigen

- Zugriff auf einen Odoo 16+ Server
- Einen Odoo-Benutzer mit Import-Berechtigungen fuer die Zielmodelle
- CSV-Dateien fuer den Import
- Optional (fuer den vollen Funktionsumfang): `ametras_fast_import_addon` auf Ihrem Odoo-Server installiert

## Installation

Sie koennen Ametras Fast Import auf zwei Arten nutzen:

1. **Desktop-App (Electron Client)**
2. **In Odoo (Addon / eingebettete Ansicht)**

### Option 1: Desktop-App

Installieren Sie das App-Paket, das Ihr Team bereitstellt (typischerweise `.dmg` auf macOS, `.exe` auf Windows, `.AppImage` auf Linux).

Die App ist aktuell **nicht von Apple/Microsoft code-signiert**. Deshalb koennen macOS und Windows den ersten Start blockieren.

#### macOS: "App can't be opened" / "developer cannot be verified"

Verwenden Sie eine dieser Methoden:

1. Im Finder die App suchen, dann **Control-Klick** auf die App und **Open** waehlen.
2. Im Warn-Dialog erneut **Open** klicken.

Falls sie weiterhin blockiert ist:

1. **System Settings** oeffnen.
2. Zu **Privacy & Security** gehen.
3. Im Security-Bereich die blockierte App-Meldung suchen.
4. **Open Anyway** klicken.
5. Mit **Open** bestaetigen.

#### Windows: "Windows protected your PC"

1. Installer/App starten.
2. Im SmartScreen-Dialog auf **More info** klicken.
3. **Run anyway** klicken.
4. Installation fortsetzen.

### Option 2: Odoo Addon (eingebetteter Modus)

Wenn Ihr Administrator den Addon-Modus bereitstellt, installieren Sie `ametras_fast_import_addon` in Ihrem Odoo-Addons-Pfad und installieren Sie es ueber Odoo Apps.

Der eingebettete Modus bietet alle serverseitigen Funktionen (z. B. Dry-Run/Zeilenvalidierung, Server-Logs und serverseitige Profilverwaltung).

## Erster Login (Desktop-App)

Im Login-Bildschirm:

1. **Server Host** eingeben (Beispiel: `mycompany.odoo.com` oder `192.168.1.100/odoo`).
2. Optional **Port & SSL** oeffnen und anpassen.
3. **Database**, **Username**, **Password** eingeben.
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
- **Settings tab**: Import-Verhalten konfigurieren (siehe Abschnitt Einstellungen unten).

### 3) Jede Datei konfigurieren

Fuer jede hochgeladene Datei:

1. **CSV Preview** pruefen.
2. **Target Model** auswaehlen.
3. **Field Mappings** pruefen und anpassen.
4. (Optional) **Validate Random Row (Dry Run)** klicken, wenn verfuegbar.

Wenn die Zuordnungen passen, **Start Import** klicken.

### 4) In `Run` ueberwachen

Waerend des Imports koennen Sie:

- **Pause** / **Resume**
- **Skip File**
- **Abort**

Ausserdem sehen Sie den Fortschritt pro Datei sowie Erfolgs- und Fehleranzahl.

### 5) In `Result` auswerten

Nach dem Import zeigt die Result-Seite:

- Gesamtanzahl Zeilen
- Erfolgreiche Zeilen
- Fehlgeschlagene Zeilen
- Dauer

Bei Fehlern koennen Sie:

- **Download Unified Error Log (CSV)**
- **Download Failed Rows ZIP (.csv)**
- **Retry Failed Rows** (wenn verfuegbar)

## Einstellungen erklaert

In `Import -> Settings` koennen Sie steuern:

- **Batch Size**: Anzahl Zeilen pro Request-Batch.
- **Workers**: parallele Verarbeitungs-Worker.
- **Encoding**: CSV-Textkodierung (`UTF-8`, `UTF-8 BOM`, `Latin-1`, `CP1252`).
- **Delimiter**: Komma, Semikolon, Tab oder Auto-Erkennung.
- **Skip header row**: normalerweise aktiv fuer uebliche CSV-Dateien.
- **Dry run (validate only)**: validiert ohne Daten zu schreiben (im Addon/eingebetteten Modus verfuegbar).
- **Language**: optionaler Odoo-Sprachcode (z. B. `de_DE`) im Addon/eingebetteten Modus.

Die Standardwerte sind fuer die meisten Importe geeignet. Passen Sie `Batch Size` und `Workers` nur an, wenn Sie ein anderes Performance-Verhalten brauchen.

## Profile

Profile helfen dabei, Import-Konfigurationen wiederzuverwenden (Modellzuordnung, Feldzuordnung, Reihenfolge, Einstellungen).

### In `Import` erstellen oder aktualisieren

- **Save as New Profile**: aktuelle Konfiguration als neues Profil speichern.
- **Update Profile**: das ausgewaehlte Profil mit den aktuellen Aenderungen aktualisieren.

### In `Profiles` verwalten

Auf der **Profiles**-Seite koennen Sie:

- **Import Profile (ZIP)** (Server-Profile, wenn verfuegbar)
- **Import Local Profile (ZIP)**
- **Export Profile (ZIP)**
- Profil **Delete**
- Fuer lokale Profile: **Push to Server**

Wichtig:

- Profil-Dateiabgleich basiert auf Dateinamen.
- Wenn benoetigte Dateien fehlen, zeigt die App eine Warnung.
- Zusaetzliche Dateien, die nicht im Profil stehen, koennen trotzdem importiert werden.

## Unterschiede: Eingebettet vs Desktop

- **Embedded (Addon in Odoo)**: voller Funktionsumfang.
- **Desktop Standalone**: funktioniert ohne Addon, aber einige Funktionen fehlen (z. B. Dry Run/Zeilenvalidierung, Server-Logs und serverseitige Profilfunktionen).

## Schnelle Fehlerbehebung

- Verbindung schlaegt fehl:
  - Host, Port, SSL, DB, Username/Password erneut pruefen.
  - Login zuerst in der normalen Odoo-Weboberflaeche testen.
- Viele Zeilenfehler:
  - Delimiter/Encoding pruefen.
  - Feldzuordnungen und Pflichtfelder erneut pruefen.
  - Fehlgeschlagene Zeilen exportieren und nur korrigierte Zeilen erneut importieren.
- Profil wird nicht wie erwartet angewendet:
  - Sicherstellen, dass CSV-Dateinamen zu den Profil-Dateinamen passen.
  - Mapping und Import-Reihenfolge in der Profiles-Seite pruefen.

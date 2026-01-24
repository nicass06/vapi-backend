import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const RESERVATIONS_TABLE = "Reservations";
const OPENING_HOURS_TABLE = "opening_hours";
const OPENING_EXCEPTIONS_TABLE = "opening_exceptions";

const MAX_CAPACITY = 10;
const SLOT_DURATION_MIN = 120;

// ============================
// HILFSFUNKTIONEN
// ============================

function extractPhone(req) {
    // 1. Schau in den tiefen Vapi-Strukturen (Call Objekt)
    const fromVapiCall = req.body?.message?.call?.customer?.number || 
                         req.body?.customer?.number || 
                         req.body?.call?.from;
    
    // 2. Schau in den direkten Parametern (falls Vapi es als Tool-Parameter sendet)
    const fromParams = req.body?.phone;

    // 3. Priorisiere die echte Anrufernummer, sonst nimm den Parameter
    const finalPhone = fromVapiCall || fromParams || "";
    
    console.log(`Extrahierte Telefonnummer: ${finalPhone}`);
    return String(finalPhone);
}

function normalizeDate(dateInput) {
    if (!dateInput) throw new Error("Kein Datum angegeben");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let candidate;
    const lowerInput = dateInput.toLowerCase();

    if (lowerInput === "today" || lowerInput === "heute") {
        candidate = new Date(today);
    } else if (lowerInput === "tomorrow" || lowerInput === "morgen") {
        candidate = new Date(today);
        candidate.setDate(candidate.getDate() + 1);
    } else if (lowerInput === "day_after_tomorrow" || lowerInput === "übermorgen") {
        candidate = new Date(today);
        candidate.setDate(candidate.getDate() + 2);
    } else if (["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].includes(lowerInput)) {
        const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
        const diff = (map[lowerInput] + 7 - today.getDay()) % 7 || 7;
        candidate = new Date(today);
        candidate.setDate(candidate.getDate() + diff);
    } else {
        const parts = dateInput.split(".");
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        let year = parts[2] ? parseInt(parts[2], 10) : today.getFullYear();
        candidate = new Date(year, month, day);
    }

    if (candidate < today) {
        candidate.setFullYear(candidate.getFullYear() + 1);
    }
    return candidate.toISOString().slice(0, 10);
}

const toHHMM = (min) => {
    const h = Math.floor(min / 60).toString().padStart(2, '0');
    const m = (min % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
};

/**
 * VERBESSERTE FUNKTION: Verarbeitet "17:00" (String) UND 61200 (Sekunden aus Airtable)
 */
function timeToMinutes(timeVal) {
    if (timeVal === undefined || timeVal === null) return 0;

    // Fall 1: Airtable liefert Sekunden als Zahl (z.B. 61200)
    if (typeof timeVal === 'number') {
        return Math.floor(timeVal / 60);
    }

    // Fall 2: Vapi/Airtable liefert String (z.B. "17:00")
    if (typeof timeVal === 'string') {
        const parts = timeVal.split(":");
        if (parts.length < 2) return 0;
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    return 0;
}

async function getOpeningForDate(dateISO) {
    const weekdayMap = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    const germanWeekday = weekdayMap[new Date(dateISO).getDay()];

    try {
        const exRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_EXCEPTIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{date}="${dateISO}"` }
        });

        if (exRes.data.records.length > 0) {
            const ex = exRes.data.records[0].fields;
            if (ex.closed) return { closed: true, reason: ex.reason || "geschlossen" };
            return { closed: false, open: ex.open_time, close: ex.close_time };
        }

        const hoursRes = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${OPENING_HOURS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `AND({restaurant_id}="main", {weekday}="${germanWeekday}")` }
        });

        if (hoursRes.data.records.length === 0) return { closed: true, reason: "Kein Eintrag" };
        const fields = hoursRes.data.records[0].fields;
        return { closed: false, open: fields.open_time, close: fields.close_time };
    } catch (e) {
        return { closed: true, reason: "Fehler bei Abfrage" };
    }
}

// ============================
// ROUTES
// ============================

app.post("/check-availability", async (req, res) => {
    try {
        const { date, time_text, guests } = req.body;
        const normalizedDate = normalizeDate(date);
        const reqMin = timeToMinutes(time_text);
        const numGuests = parseInt(guests || 0);

        console.log(`--- CHECK START ---`);
        console.log(`Anfrage für: ${normalizedDate} um ${time_text} Uhr (${numGuests} Pers.)`);

        // 1. SCHRITT: ÖFFNUNGSZEITEN PRÜFEN
        const opening = await getOpeningForDate(normalizedDate);
        
        if (opening.closed) {
            console.log(`ABGELEHNT: Restaurant ist an diesem Tag geschlossen.`);
            return res.json({ 
                success: true, 
                available: false, 
                message: `Wir haben am ${normalizedDate} leider geschlossen.` 
            });
        }

        const openMin = timeToMinutes(opening.open);
        const closeMin = timeToMinutes(opening.close);

        console.log(`Öffnungszeiten: ${opening.open} bis ${opening.close}`);

        // Prüfung: Startzeit zu früh ODER Aufenthalt (120 Min) geht über Schließzeit hinaus
        if (reqMin < openMin || (reqMin + SLOT_DURATION_MIN) > closeMin) {
            const lastPossibleMin = closeMin - SLOT_DURATION_MIN;
            const lastPossibleText = toHHMM(lastPossibleMin);
            console.log(`ABGELEHNT: Außerhalb der Öffnungszeiten. Letzter Slot: ${lastPossibleText}`);
            return res.json({ 
                success: true, 
                available: false, 
                message: `Das liegt außerhalb unserer Öffnungszeiten. Die letzte Reservierung ist um ${lastPossibleText} Uhr möglich.` 
            });
        }

        // 2. SCHRITT: KAPAZITÄT PRÜFEN (nur wenn Schritt 1 OK war)
        const resRecords = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { filterByFormula: `{status}="bestätigt"` }
        });

        let currentLoad = 0;
        resRecords.data.records.forEach(record => {
            const fields = record.fields;
            if (fields.date === normalizedDate) {
                const existingStart = timeToMinutes(fields.time_text);
                const existingEnd = existingStart + SLOT_DURATION_MIN;
                if (reqMin < existingEnd && (reqMin + SLOT_DURATION_MIN) > existingStart) {
                    currentLoad += (parseInt(fields.guests) || 0);
                }
            }
        });

        console.log(`Aktuelle Auslastung: ${currentLoad}. Kapazität nach Buchung: ${currentLoad + numGuests}`);
        console.log(`--- CHECK ENDE ---`);

        if (currentLoad + numGuests > MAX_CAPACITY) {
            return res.json({ success: true, available: false, message: "Leider sind wir zu dieser Zeit schon ausgebucht." });
        }

        return res.json({ success: true, available: true });

    } catch (err) {
        console.error("Check Error:", err.message);
        res.json({ success: false, available: false, error: err.message });
    }
});

app.post("/create-reservation", async (req, res) => {
    try {
        const { date, time_text, guests, name } = req.body;
        
        // 1. Telefonnummer extrahieren
        const phone = extractPhone(req); 
        
        // 2. Datum normalisieren (DIESE ZEILE HAT GEFEHLT!)
        const normalizedDate = normalizeDate(date);

        // 3. Name validieren
        if (!name || name.trim().toLowerCase() === "gast" || name.length < 2) {
            return res.json({ 
                success: false, 
                error: "Bitte frage den Gast nach seinem Namen." 
            });
        }

        const reqMin = timeToMinutes(time_text);
        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        const endISO = `${normalizedDate}T${toHHMM(reqMin + SLOT_DURATION_MIN)}:00.000Z`;

        console.log(`Speichere Reservierung: ${name}, ${phone}, ${normalizedDate}`);

        // 4. In Airtable speichern
        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            fields: {
                date: normalizedDate,
                time_text: String(time_text),
                guests: parseInt(guests || 1),
                name: name,
                phone: phone, // Hier wird die Nummer jetzt mitgeschickt
                status: "bestätigt",
                start_datetime: startISO,
                end_datetime: endISO
            }
        }, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" }
        });

        return res.json({ success: true });
    } catch (err) {
        console.error("Create Error:", err.message);
        res.json({ success: false, error: err.message });
    }
});

app.post("/cancel-reservation", async (req, res) => {
    try {
        const { date, time_text } = req.body;
        const phone = extractPhone(req); // Holt die Nummer des aktuellen Anrufers
        const normalizedDate = normalizeDate(date);

        console.log(`--- CANCEL START ---`);
        console.log(`Stornierung gesucht für: ${phone} am ${normalizedDate}`);

        if (!phone) {
            return res.json({ success: false, error: "Telefonnummer konnte nicht ermittelt werden." });
        }

        // Suche nach der Reservierung mit Telefonnummer UND Datum UND Status bestätigt
        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: `AND({phone}="${phone}", {date}="${normalizedDate}", {status}="bestätigt")` 
            }
        });

        if (search.data.records.length === 0) {
            console.log("Keine passende Reservierung für diese Nummer gefunden.");
            return res.json({ 
                success: false, 
                reason: "not_found", 
                message: "Ich konnte unter Ihrer Nummer keine bestätigte Reservierung für dieses Datum finden." 
            });
        }

        // Falls mehrere gefunden werden (z.B. verschiedene Uhrzeiten), nehmen wir die passende time_text
        const recordToCancel = search.data.records.find(r => r.fields.time_text === time_text) || search.data.records[0];

        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${recordToCancel.id}`, 
            { fields: { status: "storniert" } },
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );

        console.log(`Reservierung ${recordToCancel.id} erfolgreich storniert.`);
        return res.json({ success: true });
    } catch (err) {
        console.error("Cancel Error:", err.message);
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
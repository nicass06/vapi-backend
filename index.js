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
    // 1. Schau direkt im Root des Bodys (falls über {{customer.number}} gemappt)
    if (req.body.phone && !req.body.phone.includes('{')) return req.body.phone;

    // 2. Schau in der Vapi-spezifischen Tool-Call Struktur
    const toolParam = req.body.message?.toolCalls?.[0]?.function?.arguments?.phone;
    if (toolParam && !toolParam.includes('{')) return toolParam;

    // 3. Schau in den Anrufer-Metadaten
    const metadata = req.body.message?.call?.customer?.number || 
                     req.body.customer?.number || 
                     req.body.call?.from;

    return metadata || "Unbekannt";
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
        
        // Erst die Variablen definieren!
        const phone = extractPhone(req); 
        const normalizedDate = normalizeDate(date); // Das löst deinen "not defined" Fehler
        const reqMin = timeToMinutes(time_text);

        // Name prüfen
        if (!name || name === "Gast") {
            return res.json({ success: false, error: "Bitte nach dem Namen fragen." });
        }

        // ISO Zeiten für Airtable berechnen
        const startISO = `${normalizedDate}T${time_text}:00.000Z`;
        const endISO = `${normalizedDate}T${toHHMM(reqMin + 120)}:00.000Z`;

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            fields: {
                date: normalizedDate,
                time_text: String(time_text),
                guests: parseInt(guests || 1),
                name: name,
                phone: phone, // Hier landet jetzt die Nummer statt {{call.from}}
                status: "bestätigt",
                start_datetime: startISO,
                end_datetime: endISO
            }
        }, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
        });

        return res.json({ success: true });
    } catch (err) {
        console.error("Create Error:", err.message);
        res.json({ success: false, error: err.message });
    }
});

app.post("/cancel-reservation", async (req, res) => {
    try {
        const { reservation_id } = req.body; // Vapi sendet die ID aus dem vorherigen Tool-Call

        if (!reservation_id) {
            return res.json({ success: false, error: "Keine Reservierungs-ID übermittelt." });
        }

        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${reservation_id}`, 
            { fields: { status: "storniert" } },
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );

        console.log(`Reservierung ${reservation_id} erfolgreich storniert.`);
        return res.json({ success: true });
    } catch (err) {
        console.error("Cancel Error:", err.message);
        res.json({ success: false, error: err.message });
    }
});

app.post("/get-reservation-by-phone", async (req, res) => {
    try {
        const phone = extractPhone(req);
        console.log(`--- GET RESERVATION START ---`);
        console.log(`Eingehende Nummer für Suche: ${phone}`);

        if (!phone || phone === "Unbekannt") {
            console.log("Abbruch: Keine Telefonnummer erkannt.");
            return res.json({ success: false, message: "Telefonnummer nicht erkannt." });
        }

        // Wir bauen den Filter sauber zusammen und loggen ihn zur Kontrolle
        // Dieser Filter löscht beim Suchen alle Leerzeichen in Airtable, falls welche da sind
	const filter = `AND(SUBSTITUTE({phone}, ' ', '')='${phone.replace(/\s/g, '')}', {status}='bestätigt')`;
	console.log(`Sende Sicherheits-Filter: ${filter}`);

        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: filter,
                sort: [{ field: "date", direction: "asc" }]
            }
        });

        const records = search.data.records;
        console.log(`Airtable Abfrage beendet. Treffer gefunden: ${records.length}`);

        if (records.length === 0) {
            return res.json({ success: false, message: "Keine aktive Reservierung gefunden." });
        }

        const resData = records[0].fields;
        console.log(`Reservierung gefunden für: ${resData.name} am ${resData.date}`);

        return res.json({ 
            success: true, 
            reservation_id: records[0].id,
            date: resData.date,
            time: resData.time_text,
            name: resData.name,
            guests: resData.guests
        });

    } catch (err) {
        // Erweitertes Error-Logging, falls die API-Anfrage fehlschlägt
        console.error("KRITISCHER FEHLER in get-reservation-by-phone:");
        if (err.response) {
            console.error("Airtable Error Data:", err.response.data);
            console.error("Airtable Error Status:", err.response.status);
        } else {
            console.error("Error Message:", err.message);
        }
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
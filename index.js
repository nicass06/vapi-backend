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

// ========================
// FESTE KONFIGURATION IM CODE
// ========================
const MAX_CAPACITY = 10; 

// ========================
// HILFSFUNKTIONEN
// ========================

function extractPhone(req) {
    const metadata = req.body.message?.call?.customer?.number || 
                     req.body.call?.customer?.number || 
                     req.body.customer?.number;
    
    if (metadata && metadata.length > 5 && !metadata.includes('{')) return metadata;
    const paramPhone = req.body.phone || req.body.message?.toolCalls?.[0]?.function?.arguments?.phone;
    if (paramPhone && paramPhone.length > 5 && !paramPhone.includes('{')) return paramPhone;
    return "Unbekannt";
}

function normalizeDate(dateInput) {
    if (!dateInput) return null;
    let today = new Date();
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
    } else {
        const parts = dateInput.split(".");
        if (parts.length >= 2) {
            let day = parseInt(parts[0], 10);
            let month = parseInt(parts[1], 10) - 1;
            let year = parts[2] ? parseInt(parts[2], 10) : today.getFullYear();
            candidate = new Date(year, month, day);
        } else {
            candidate = new Date(dateInput);
        }
    }
    return candidate.toISOString().slice(0, 10);
}

// ========================
// ROUTES
// ========================

// 1. Verfügbarkeit prüfen (Einfacher Text-Abgleich der Uhrzeit)
app.post("/check-availability", async (req, res) => {
    try {
        const { date, time_text } = req.body; // Erwartet "YYYY-MM-DD" und "HH:mm"

        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: `AND({date}='${date}', {time_text}='${time_text}', {status}='bestätigt')` 
            }
        });

        const count = search.data.records.length;

        if (count < MAX_CAPACITY) {
            res.json({ success: true, remaining: MAX_CAPACITY - count });
        } else {
            res.json({ success: false, message: "In diesem Slot sind leider alle Tische belegt." });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 2. Reservierung erstellen
app.post("/create-reservation", async (req, res) => {
    try {
        const args = req.body.message?.toolCalls?.[0]?.function?.arguments || req.body;
        const { date, time_text, guests, name } = args;
        const phone = extractPhone(req);
        const normalizedDate = normalizeDate(date);

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            fields: {
                date: normalizedDate,
                time_text,
                guests: parseInt(guests || 1),
                name,
                phone,
                status: "bestätigt"
            }
        }, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });

        return res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// 3. Suche per Telefon
app.post("/get-reservation-by-phone", async (req, res) => {
    try {
        const phone = extractPhone(req);
        const cleanPhone = phone.replace(/[^\d+]/g, ''); 
        
        const filter = `AND(NOT({phone} = ''), SEARCH('${cleanPhone}', SUBSTITUTE({phone}, ' ', '')), {status}='bestätigt')`;

        const search = await axios.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
            params: { 
                filterByFormula: filter,
                sort: [{ field: "date", direction: "desc" }]
            }
        });

        if (search.data.records.length === 0) return res.json({ success: false });

        const record = search.data.records[0];
        return res.json({
            success: true,
            reservation_id: record.id,
            date: record.fields.date,
            time: record.fields.time_text,
            name: record.fields.name
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 4. Stornieren
app.post("/cancel-reservation", async (req, res) => {
    try {
        const reservation_id = req.body.reservation_id || 
                               req.body.message?.toolCalls?.[0]?.function?.arguments?.reservation_id;

        if (!reservation_id) return res.json({ success: false, message: "ID fehlt" });

        await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${RESERVATIONS_TABLE}/${reservation_id}`, 
            { fields: { status: "storniert" } },
            { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" } }
        );

        return res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
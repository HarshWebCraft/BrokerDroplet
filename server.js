const express = require("express");
const cron = require("node-cron");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const User = require("./models/users.js");
const APIModel = require("./models/Api");
const Subscription = require("./models/Subscription.js");
const bodyParser = require("body-parser");
const cors = require("cors");
const PORT = process.env.PORT || 8080;

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "https://your-netlify-app.netlify.app",
  "https://xalgos.in",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
    credentials: true,
    optionsSuccessStatus: 204,
  })
);

app.use(express.text());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ limit: "10mb", extended: true }));

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://harshdvadhavana26:harshdv007@try.j3wxapq.mongodb.net/X-Algos?retryWrites=true&w=majority";

mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

app.get("/health", (req, res) => {
  if (mongoose.connection.readyState === 1) {
    res.status(200).json({ status: "healthy" });
  } else {
    res
      .status(503)
      .json({ status: "unhealthy", error: "MongoDB not connected" });
  }
});

const sseClients = new Map();

app.get("/broker-status-stream/:email", (req, res) => {
  const email = req.params.email;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin":
      req.headers.origin || "https://your-netlify-app.netlify.app",
    "Access-Control-Allow-Credentials": "true",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  if (!sseClients.has(email)) {
    sseClients.set(email, []);
  }

  const clientList = sseClients.get(email);
  clientList.push(res);

  res.write(`data: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);

  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ message: "heartbeat" })}\n\n`);
    } catch (err) {
      clearInterval(heartbeatInterval);
      clientList.splice(clientList.indexOf(res), 1);
      if (clientList.length === 0) {
        sseClients.delete(email);
      }
      res.end();
    }
  }, 10000);

  req.on("close", () => {
    clearInterval(heartbeatInterval);
    const clientList = sseClients.get(email) || [];
    sseClients.set(
      email,
      clientList.filter((client) => client !== res)
    );
    if (sseClients.get(email).length === 0) {
      sseClients.delete(email);
    }
    res.end();
  });
});

const notifyBrokerStatusUpdate = (email, brokerData) => {
  const clientList = sseClients.get(email) || [];
  clientList.forEach((client) => {
    try {
      client.write(`data: ${JSON.stringify(brokerData)}\n\n`);
    } catch (err) {
      console.error(`❌ Error sending SSE to ${email}:`, err.message);
    }
  });
};

const getTimezoneFromLabel = (label) => {
  if (!label) return "Asia/Kolkata";
  const match = label.match(/\((UTC[+-]\d{2}:\d{2})\)/);
  if (match) {
    const offset = match[1].replace("UTC", "");
    const zones = moment.tz.names();
    return (
      zones.find((zone) => moment.tz(zone).format("Z") === offset) ||
      "Asia/Kolkata"
    );
  }
  if (label.includes("IST")) return "Asia/Kolkata";
  return "Asia/Kolkata";
};

cron.schedule("*/60 * * * * *", async () => {
  try {
    const users = await User.find({})
      .select("Email ListOfBrokers XalgoID")
      .lean();

    if (!users || users.length === 0) {
      return;
    }

    for (const user of users) {
      const subscriptions = await Subscription.find({
        XalgoID: user.XalgoID,
      }).lean();

      let userNeedsUpdate = false;
      const brokers = [...(user.ListOfBrokers || [])];
      const updatedBrokers = [];

      for (let broker of brokers) {
        let shouldBeActive = broker.isActive;
        const tz = broker.tradingTimes?.[0]?.timezone
          ? getTimezoneFromLabel(broker.tradingTimes[0].timezone)
          : "Asia/Kolkata";
        const now = moment().tz(tz);

        if (!broker.tradingTimes || broker.tradingTimes.length === 0) {
          updatedBrokers.push({ ...broker });
          continue;
        }

        let isWithinTimeWindow = false;
        for (const time of broker.tradingTimes) {
          const start = moment.tz(tz).set({
            year: now.year(),
            month: now.month(),
            date: now.date(),
            hour: parseInt(time.startHour, 10),
            minute: parseInt(time.startMinute, 10),
            second: 0,
          });
          const end = moment.tz(tz).set({
            year: now.year(),
            month: now.month(),
            date: now.date(),
            hour: parseInt(time.endHour, 10),
            minute: parseInt(time.endMinute, 10),
            second: 0,
          });

          if (now.isSameOrAfter(start) && now.isBefore(end)) {
            isWithinTimeWindow = true;
            shouldBeActive = true;
            break;
          }
        }

        if (!isWithinTimeWindow) {
          shouldBeActive = false;
        }

        if (broker.isActive !== shouldBeActive) {
          broker.isActive = shouldBeActive;
          userNeedsUpdate = true;

          try {
            const updateResult = await APIModel.updateOne(
              { "Apis.ApiID": broker.clientId, XAlgoID: "XAlgoID" },
              { $set: { "Apis.$.IsActive": shouldBeActive } }
            );
            if (updateResult.matchedCount === 0) {
              console.error(
                `❌ No matching ApiID ${broker.clientId} or XAlgoID ${user.XalgoID} in APIModel`
              );
            }
          } catch (err) {
            console.error(
              `❌ Failed to update APIModel for ${broker.clientId}:`,
              err.message
            );
          }
        }
        updatedBrokers.push({ ...broker });
      }

      // Subscription validation (for logging only)
      const grouped = {};
      updatedBrokers.forEach((b) => {
        let type = b.broker?.toLowerCase()?.replace(/\s+/g, "") || "unknown";
        if (type === "motilal" || type === "angelone") {
          type = "indianbroker";
        }
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(b);
      });

      const now = moment();
      for (const [type, list] of Object.entries(grouped)) {
        const validSubscriptions = subscriptions.filter((s) => {
          const accType = s.Account?.toLowerCase()?.replace(/\s+/g, "");
          if (type === "indianbroker" && accType !== "indianbroker") {
            return false;
          }
          if (type !== "indianbroker" && accType !== type) {
            return false;
          }

          if (!s.CreatedAt || !moment(s.CreatedAt).isValid()) {
            return false;
          }

          const durationDays = parseInt(s.Duration, 10);
          if (isNaN(durationDays) || durationDays <= 0) {
            return false;
          }

          const createdAt = moment(s.CreatedAt);
          const expiresAt = createdAt.clone().add(durationDays, "days");
          const isValid = now.isBefore(expiresAt);

          if (isValid) {
            console.log(
              `✅ Valid subscription for ${type}: ID=${s._id}, NoOfAPI=${s.NoOfAPI}`
            );
          }
          return isValid;
        });

        const totalAPI = validSubscriptions.reduce((sum, s) => {
          const apiCount = parseInt(s.NoOfAPI, 10);
          return isNaN(apiCount) || apiCount < 0 ? sum : sum + apiCount;
        }, 0);

        console.log(
          `🔍 ${type}: ${totalAPI} API slots, ${list.length} brokers`
        );
      }

      if (userNeedsUpdate) {
        try {
          await User.updateOne(
            { Email: user.Email },
            { $set: { ListOfBrokers: updatedBrokers } }
          );
          notifyBrokerStatusUpdate(user.Email, {
            brokers: updatedBrokers,
            dbUpdated: true,
          });
        } catch (err) {
          console.error(
            `❌ Failed to save broker updates for ${user.Email}:`,
            err.message
          );
          notifyBrokerStatusUpdate(user.Email, {
            brokers: updatedBrokers,
            dbUpdated: false,
          });
        }
      } else {
        notifyBrokerStatusUpdate(user.Email, {
          brokers: updatedBrokers,
          dbUpdated: false,
        });
      }
    }

    console.log(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>> complete");
  } catch (error) {
    console.error("❌ Cron job error:", error.message);
  }
});

app.get("/trigger-cron", async (req, res) => {
  try {
    await require("./server").cron();
    res.status(200).json({ message: "Cron triggered successfully" });
  } catch (err) {
    console.error("❌ Manual cron trigger error:", err.message);
    res.status(500).json({ error: "Failed to trigger cron" });
  }
});

app.listen(PORT, () => console.log("Server running on port 8080"));

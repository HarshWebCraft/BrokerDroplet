const express = require("express");
const cron = require("node-cron");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const User = require("./models/users.js");
const APIModel = require("./models/Api");
const Subscription = require("./models/Subscription.js");
const bodyParser = require("body-parser");
const cors = require("cors");

const PORT = process.env.PORT || 8000;

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
        console.error(`CORS blocked for origin: ${origin}`);
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
  console.log(
    `SSE client connected for ${email}. Total clients: ${clientList.length}, Origin: ${req.headers.origin}`
  );

  res.write(`data: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);

  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ message: "heartbeat" })}\n\n`);
    } catch (err) {
      console.error(`❌ Heartbeat error for ${email}:`, err.message);
      clearInterval(heartbeatInterval);
      clientList.splice(clientList.indexOf(res), 1);
      if (clientList.length === 0) {
        sseClients.delete(email);
      }
      res.end();
    }
  }, 10000);

  req.on("error", (err) => {
    console.error(`❌ Request error for ${email}: ${err.message}`);
  });

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
    console.log(
      `SSE client disconnected for ${email}. Remaining clients: ${
        sseClients.get(email)?.length || 0
      }, Origin: ${req.headers.origin}`
    );
    res.end();
  });
});

const notifyBrokerStatusUpdate = (email, brokerData) => {
  const clientList = sseClients.get(email) || [];
  console.log(
    `📤 Sending SSE notification for ${email}: dbUpdated=${brokerData.dbUpdated}, brokers=`,
    brokerData.brokers
  );
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
  console.log(
    "\n⏰ Cron started at",
    moment().tz("Asia/Kolkata").format("HH:mm:ss")
  );

  try {
    const users = await User.find({})
      .select("Email ListOfBrokers XalgoID")
      .lean();

    if (!users || users.length === 0) {
      console.log("❌ No users found in the database");
      return;
    }

    for (const user of users) {
      console.log(
        `\n📦 Processing user: ${user.Email}, XalgoID: ${user.XalgoID}`
      );

      // Fetch subscriptions for the user
      const subscriptions = await Subscription.find({
        XalgoID: user.XalgoID,
      }).lean();
      console.log(
        `Subscriptions for ${user.Email}:`,
        JSON.stringify(subscriptions, null, 2)
      );

      let userNeedsUpdate = false;
      const brokers = [...(user.ListOfBrokers || [])];
      const updatedBrokers = [];

      // Process isActive based on trading times
      for (let broker of brokers) {
        let shouldBeActive = broker.isActive;
        const tz = broker.tradingTimes?.[0]?.timezone
          ? getTimezoneFromLabel(broker.tradingTimes[0].timezone)
          : "Asia/Kolkata";
        const now = moment().tz(tz);

        console.log(
          `Checking trading times for ${broker.clientId} (Broker: ${broker.broker}):`,
          broker.tradingTimes
        );

        if (!broker.tradingTimes || broker.tradingTimes.length === 0) {
          console.log(
            `ℹ No trading times for ${broker.clientId}, preserving isActive=${broker.isActive}`
          );
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

          const remainingSeconds = end.diff(now, "seconds");
          const untilStart = start.diff(now, "seconds");

          console.log(
            `Time window for ${broker.clientId}: ${start.format(
              "HH:mm"
            )} - ${end.format("HH:mm")} (Now: ${now.format("HH:mm:ss")})`
          );

          if (now.isSameOrAfter(start) && remainingSeconds >= 0) {
            isWithinTimeWindow = true;
            shouldBeActive = true;
            console.log(
              `✅ ${broker.clientId} is ACTIVE. Ends in ${remainingSeconds}s`
            );
            break;
          } else if (now.isBefore(start)) {
            console.log(`🕒 ${broker.clientId} will start in ${untilStart}s`);
          } else {
            console.log(`❌ ${broker.clientId} is currently inactive.`);
          }
        }

        if (!isWithinTimeWindow) {
          shouldBeActive = false;
        }

        if (broker.isActive !== shouldBeActive) {
          console.log(
            `➡ Updating ${broker.clientId} isActive from ${broker.isActive} → ${shouldBeActive}`
          );
          broker.isActive = shouldBeActive;
          userNeedsUpdate = true;

          try {
            const updateResult = await APIModel.updateOne(
              { "Apis.ApiID": broker.clientId, XAlgoID: user.XalgoID },
              { $set: { "Apis.$.IsActive": shouldBeActive } }
            );
            if (updateResult.matchedCount === 0) {
              console.error(
                `❌ No matching ApiID ${broker.clientId} or XAlgoID ${user.XalgoID} in APIModel`
              );
            } else if (updateResult.modifiedCount === 0) {
              console.error(
                `❌ No changes applied for ${broker.clientId} in APIModel`
              );
            } else {
              console.log(
                `✅ APIModel updated for ${broker.clientId} (isActive=${shouldBeActive})`
              );
            }
          } catch (err) {
            console.error(
              `❌ Failed to update APIModel for ${broker.clientId}:`,
              err.message
            );
          }
        } else {
          console.log(
            `ℹ No change in isActive for ${broker.clientId} (remains ${broker.isActive})`
          );
        }
        updatedBrokers.push({ ...broker });
      }

      // Subscription validation and canActivate assignment
      const grouped = {};
      updatedBrokers.forEach((b) => {
        let type = b.broker?.toLowerCase()?.replace(/\s+/g, "") || "unknown";
        // Group Motilal and AngelOne as indianbroker
        if (type === "motilal" || type === "angelone") {
          type = "indianbroker";
        }
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(b);
      });

      const result = [];
      const now = moment();

      for (const [type, list] of Object.entries(grouped)) {
        // Filter valid subscriptions
        const validSubscriptions = subscriptions.filter((s) => {
          const accType = s.Account?.toLowerCase()?.replace(/\s+/g, "");
          if (!accType || accType !== type) {
            console.log(
              `❌ Subscription skipped for ${type}: Account=${
                s.Account || "undefined"
              } does not match`
            );
            return false;
          }

          if (!s.CreatedAt || !moment(s.CreatedAt).isValid()) {
            console.log(
              `❌ Subscription skipped for ${type}: Invalid CreatedAt=${s.CreatedAt}`
            );
            return false;
          }

          const durationDays = parseInt(s.Duration, 10);
          if (isNaN(durationDays) || durationDays <= 0) {
            console.log(
              `❌ Subscription skipped for ${type}: Invalid Duration=${s.Duration}`
            );
            return false;
          }

          const createdAt = moment(s.CreatedAt);
          const expiresAt = createdAt.clone().add(durationDays, "days");
          const isValid = now.isBefore(expiresAt);

          if (!isValid) {
            console.log(
              `❌ Subscription skipped for ${type}: ID=${
                s._id
              }, Expired at ${expiresAt.format(
                "YYYY-MM-DD HH:mm:ss"
              )} (Now: ${now.format("YYYY-MM-DD HH:mm:ss")})`
            );
            return false;
          }

          console.log(
            `✅ Valid subscription for ${type}: ID=${s._id}, Account=${
              s.Account
            }, CreatedAt=${createdAt.format(
              "YYYY-MM-DD HH:mm:ss"
            )}, Duration=${durationDays}d, ExpiresAt=${expiresAt.format(
              "YYYY-MM-DD HH:mm:ss"
            )}, NoOfAPI=${s.NoOfAPI || "undefined"}`
          );

          return true;
        });

        const totalAPI = validSubscriptions.reduce((sum, s) => {
          const apiCount = parseInt(s.NoOfAPI, 10);
          if (isNaN(apiCount) || apiCount < 0) {
            console.log(
              `❌ Invalid NoOfAPI for subscription ${s._id}: ${s.NoOfAPI}`
            );
            return sum;
          }
          return sum + apiCount;
        }, 0);

        console.log(
          `🔍 Broker Type: ${type}, Total API slots: ${totalAPI}, Brokers: ${list.length}`
        );

        list.forEach((broker, index) => {
          let canActivate;
          if (type === "indianbroker") {
            // For IndianBroker, only allow canActivate for up to totalAPI brokers
            canActivate = index < totalAPI;
          } else {
            canActivate = index < totalAPI;
          }
          const plain = { ...broker, canActivate };
          result.push(plain);

          console.log(
            ` ➡ Broker ${broker.clientId} (${broker.broker}): index=${index}, totalAPI=${totalAPI}, canActivate=${canActivate}`
          );
        });
      }

      // Update user if needed
      if (userNeedsUpdate) {
        try {
          await User.updateOne(
            { Email: user.Email },
            { $set: { ListOfBrokers: updatedBrokers } }
          );
          console.log(`✅ User ${user.Email} broker status updated in DB`);
          notifyBrokerStatusUpdate(user.Email, {
            brokers: result,
            dbUpdated: true,
          });
        } catch (err) {
          console.error(
            `❌ Failed to save broker updates for ${user.Email}:`,
            err.message
          );
          notifyBrokerStatusUpdate(user.Email, {
            brokers: result,
            dbUpdated: false,
          });
        }
      } else {
        console.log(`ℹ No broker status change needed for ${user.Email}`);
        notifyBrokerStatusUpdate(user.Email, {
          brokers: result,
          dbUpdated: false,
        });
      }
    }
  } catch (error) {
    console.error("❌ Cron job error:", error.message, error.stack);
  }
});

app.get("/trigger-cron", async (req, res) => {
  try {
    await require("./server").cron();
    res.status(200).json({ message: "Cron triggered successfully" });
  } catch (err) {
    console.error("❌ Manual cron trigger error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to trigger cron" });
  }
});

app.listen(PORT, () => console.log("Server running on port 8080"));

// import mongoose from "mongoose";

// const db = async () => {
//   try {
//     mongoose.set("strictQuery", false);
//     await mongoose.connect(process.env.MONGODB_URI, {
//       useUnifiedTopology: true,
//       useNewUrlParser: true,
//     });
//   } catch (error) {
//     throw new Error("Connection Failed!");
//   }
// };

// export default db;

import mongoose from "mongoose";

const connection = {};

async function connect() {
  if (connection.isConnected) {
    return;
  }

  const db = await mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  connection.isConnected = db.connections[0].readyState;
  console.log("MongoDB connected");
}

async function disconnect() {
  if (connection.isConnected) {
    await mongoose.disconnect();
    connection.isConnected = false;
    console.log("MongoDB disconnected");
  }
}

const db = { connect, disconnect };
export default db;

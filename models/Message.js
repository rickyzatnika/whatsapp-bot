import mongoose from "mongoose";

const MessagesSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  messages: [{ type: String }],
});

mongoose.models = {};
const Messages = mongoose.model("Messages", MessagesSchema);

export default Messages;

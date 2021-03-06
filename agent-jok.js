const envLoaded = require('dotenv').load({silent: true});
if (!envLoaded) console.log('warning:', __filename, '.env cannot be found');

const appSettings = require('./appSettings.json');
const http = require('http');
const express = require('express');
let request = require('request-promise');
const { logExpression, setLogLevel } = require('@cisl/zepto-logger');
// logExpression is like console.log, but it also
//   * outputs a timestamp
//   * first argument takes text or JSON and handles it appropriately
//   * second numeric argument establishes the logging priority: 1: high, 2: moderate, 3: low
//   * logging priority n is set by -level n option on command line when agent-jok is started

let methodOverride = require('method-override');
let bodyParser = require('body-parser');

const {classifyMessage} = require('./conversation.js');
const {extractBidFromMessage, interpretMessage} = require('./extract-bid.js');
const argv = require('minimist')(process.argv.slice(2));

let myPort = argv.port || appSettings.defaultPort || 14007;
let agentName = appSettings.name || "Agent007";

const defaultRole = 'buyer';
const defaultSpeaker = 'Jeff';
const defaultAddressee = agentName;
const defaultRoundDuration = 600;
const defaultRoundId = 0;

let roundId;


const rejectionMessages = [	
  "No thanks. Your offer is much too low for me to consider.",	
  "Forget it. That's not a serious offer.",	
  "Sorry. You're going to have to do a lot better than that!"	
];	
const acceptanceMessages = [	
  "You've got a deal! I'll sell you",	
  "You've got it! I'll let you have",	
  "I accept your offer. Just to confirm, I'll give you"	
];	
const confirmAcceptanceMessages = [	
  "I confirm that I'm selling you ",	
  "I'm so glad! This is to confirm that I'll give you ",	
  "Perfect! Just to confirm, I'm giving you "	
];	
const multiMessages = [	
  "The quality of my produce is the best in town. You will not be disappointed.",	
  "All of my goods are from local farms. I can guarantee their quality and freshness.",	
  "This bundle is the best deal you can get in town guaranteed!"	
];	
const eggMessages = [	
  "All my eggs come from farm raised chickens, so I can guarantee their quality.",	
  "I had these eggs delivered to me this morning, so I can guarantee their freshness.",	
  "The eggs I sell are award winning eggs. They're the best in the state!"	
];	
const flourMessages = [	
  "My flour is top notch. You will not be disappointed!",	
  "Only the best of my flour is sold at these times.",	
  "The flour is fresh from the local mill!"	
];	
const milkMessages = [	
  "The milk I sell comes from a local farm and is delivered to me daily.",	
  "I drink it everyday!",	
  "I use it to make all of my pasteries!"	
];	
const sugarMessages = [	
  "The sugar I sell is completely organic and made from sugar cane.",	
  "I can guarantee that my sugar is the best in town.",	
  "My sugar is perfect for cakes and pancakes!"	
];	
const chocolateMessages = [	
  "The chocolate is made by my daughter, so you can know for sure that its top quality.",	
  "My wife loves this chocolate, so I buy it for her every year.",	
  "The chocolate is especailly good for making pasteries!"	
];	
const vanillaMessages = [	
  "This vanilla is usually very expensive, but I'm giving it to you for half price.",	
  "This vanilla is very strong and fresh.",	
  "Many local chefs prefer it over the ones found in stores."	
];	
const blueberryMessages = [	
  "The blueberrys are fresh from my own garden. I can guarantee that they are fresh.",	
  "Blueberrys are in season right now, and they go perfectly with pancakes.",	
  "My blueberries have won multiple awards throughout the years. This batch won't disappoint!"	
];	


let negotiationState = {
  "active": false,
  "startTime": null,
  "roundDuration": defaultRoundDuration
};

let polite = true; // Set to true to force agent to only respond to offers addressed to it; false will yield rude behavior
let logLevel = 1;

if (argv.level) {
  logLevel = argv.level;
  console.log(`Setting log level to ${logLevel}`, 1);
}
setLogLevel(logLevel);

if (argv.polite) {
  if (argv.polite.toLowerCase() === 'false') {
    polite = false;
  }
  console.log(`Setting politeness to ${polite}`, 2);
}

const app = express();

app.set('port', process.env.PORT || myPort);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(methodOverride());

let utilityInfo = null;
let bidHistory;


// ************************************************************************************************************ //
// REQUIRED APIs
// ************************************************************************************************************ //

// API route that receives utility information from the environment orchestrator. This also
// triggers the start of a round and the associated timer.
app.post('/setUtility', (req, res) => {
  console.log("Inside setUtility (POST).", 2);
  if(req.body) {
    roundId = req.body.roundId;
    utilityInfo = req.body;
    console.log("Received utilityInfo: ", 2);
    console.log(utilityInfo, 2);
    agentName = utilityInfo.name || agentName;
    console.log("agentName: " + agentName, 2);
    let msg = {roundId, "status": "Acknowledged", "utility": utilityInfo};
    console.log(msg, 2);
    res.json(msg);
  }
  else {
    let msg = {"status": "Failed; no message body", "utility": null};
    console.log(msg, 2);
    res.json(msg);
  }
});

// API route that tells the agent that the round has started.
app.post('/startRound', (req, res) => {
  console.log("Inside startRound (POST).", 2);
  bidHistory = {};
  if(req.body) {
    negotiationState.roundDuration = req.body.roundDuration || negotiationState.roundDuration;
    negotiationState.roundId = req.body.roundId || negotiationState.roundId;
  }
  negotiationState.active = true;
  negotiationState.startTime = new Date();
  negotiationState.stopTime = new Date(negotiationState.startTime.getTime() + 1000 * negotiationState.roundDuration);
  console.log("Negotiation state is: ", 2);
  console.log(negotiationState, 2);
  let msg = {roundId, "status": "Acknowledged"};
  res.json(msg);
});

// API route that tells the agent that the round has ended.
app.post('/endRound', (req, res) => {
  console.log("Inside endRound (POST).", 2);
  negotiationState.active = false;
  negotiationState.endTime = new Date();
  console.log("Negotiation state is: ", 2);
  console.log(negotiationState, 2);
  let msg = {roundId, "status": "Acknowledged"};
  res.json(msg);
});

// POST API that receives a message, interprets it, decides how to respond (e.g. Accept, Reject, or counteroffer),
// and if it desires sends a separate message to the /receiveMessage route of the environment orchestrator
app.post('/receiveMessage', (req, res) => {
  console.log("Inside receiveMessage (POST).", 2);
  let timeRemaining = ((new Date(negotiationState.stopTime)).getTime() - (new Date()).getTime())/ 1000.0;
  console.log("Remaining time: " + timeRemaining, 2);
  console.log("Negotiation state: " + negotiationState.active, 2);
  console.log("POSTed body: ", 2);
  console.log(req.body, 2);
  if(timeRemaining <= 0) negotiationState.active = false;

  let response = null;

  if(!req.body) {
    response = {
      "status": "Failed; no message body"
    };
  }
  else if(negotiationState.active) { // We received a message and time remains in the round.
    let message = req.body;
    message.speaker = message.speaker || defaultSpeaker;
    message.addressee = message.addressee;
    message.role = message.role || message.defaultRole;
    message.roundId = message.roundId || defaultRoundId;
    response = { // Acknowledge receipt of message from the environment orchestrator
      roundId,
      status: "Acknowledged",
      interpretation: message
    };
    console.log("Message is: ", 2);
    console.log(message, 2);

    processMessage(message)
    .then(bidMessage => {
      console.log("Bid message is: ", 2);
      console.log(bidMessage, 2);
      if(bidMessage) { // If warranted, proactively send a new negotiation message to the environment orchestrator
        sendMessage(bidMessage);
      }
    })
    .catch(error => {
      console.log("Did not send message; encountered error: ", 1);
      console.log(error, 1);
    });
  }
  else { // Either there's no body or the round is over.
    response = {
      status: "Failed; round not active"
    };
  }
  res.json(response);
});

// POST API that receives a rejection message, and decides how to respond to it. If the rejection is based upon
// insufficient funds on the part of the buyer, generate an informational message to send back to the human, as a courtesy
// (or rather to explain why we are not able to confirm acceptance of an offer).
app.post('/receiveRejection', (req, res) => {
  console.log("Inside receiveRejection (POST).", 2);
  let timeRemaining = ((new Date(negotiationState.stopTime)).getTime() - (new Date()).getTime())/ 1000.0;
  console.log("Remaining time: " + timeRemaining, 2);
  console.log("POSTed body: ", 2);
  console.log(req.body, 2);
  if(timeRemaining <= 0) negotiationState.active = false;
  let response = null;
  if(!req.body) {
    response = {
      "status": "Failed; no message body"
    };
  }
  else if(negotiationState.active) { // We received a message and time remains in the round.
    let message = req.body;
    console.log("Rejected message is: ", 2);
    console.log(message, 2);
    response = { // Acknowledge receipt of message from the environment orchestrator
      roundId,
      status: "Acknowledged",
      message
    };
    if(
      message.rationale &&
      message.rationale == "Insufficient budget" &&
      message.bid &&
      message.bid.type == "Accept"
    ) { // We tried to respond with an accept, but were rejected. So that the buyer will not interpret our apparent silence as rudeness, explain to the Human that he/she were rejected due to insufficient budget.
      let msg2 = JSON.parse(JSON.stringify(message));
      delete msg2.rationale;
      delete msg2.bid;
      msg2.timestamp = new Date();
      msg2.text = "I'm sorry, " + msg2.addressee + ". I was ready to make a deal, but apparently you don't have enough money left.";
      sendMessage(msg2);
    }
  } else { // Either there's no body or the round is over.
    response = {
      status: "Failed; round not active"
    };
  }
  res.json(response);
});


// ************************************************************************************************************ //
// Non-required APIs (useful for unit testing)
// ************************************************************************************************************ //


// GET API route that simply calls Watson Assistant on the supplied text message to obtain intent and entities
app.get('/classifyMessage', (req, res) => {
  console.log("Inside classifyMessage (GET).", 2);
  if(req.query.text) {
    let text = req.query.text;
    let message = { // Hard-code the speaker, role and envUUID
      text,
      speaker: defaultSpeaker,
      addressee: defaultAddressee,
      role: defaultRole,
      environmentUUID: defaultEnvironmentUUID
    };
    console.log("Message is: ", 2);
    console.log(message, 2);
    return classifyMessage(message)
    .then(waResponse => {
      waResponse.roundId = roundId;
      console.log("Response from Watson Assistant: ", 2);
      console.log(waResponse, 2);
      res.json(waResponse);
    });
  }
});

// POST API route that simply calls Watson Assistant on the supplied text message to obtain intents and entities
app.post('/classifyMessage', (req, res) => {
  console.log("Inside classifyMessage (POST).", 2);
  if(req.body) {
    let message = req.body;
    message.speaker = message.speaker || defaultSpeaker;
    message.addressee = message.addressee || null;
    message.role = message.role || message.defaultRole;
    message.environmentUUID = message.environmentUUID || defaultEnvironmentUUID;
    console.log("Message is: ", 2);
    console.log(message, 2);
    return classifyMessage(message)
    .then(waResponse => {
      waResponse.roundId = roundId;
      console.log("Response from Watson Assistant : ", 2);
      console.log(waResponse, 2);
      res.json(waResponse);
    })
    .catch(err => {
      console.log("Error from Watson Assistant: ", 2);
      console.log(err, 2);
      res.json(err);
    });
  }
});

// POST API route that is similar to /classify Message, but takes the further
// step of determining the type and parameters of the message (if it is a negotiation act),
// and formatting this information in the form of a structured bid.
app.post('/extractBid', (req, res) => {
  console.log("Inside extractBid (POST).", 2);
  if(req.body) {
    let message = req.body;
    message.speaker = message.speaker || defaultSpeaker;
    message.addressee = message.addressee || null;
    message.role = message.role || message.defaultRole;
    message.environmentUUID = message.environmentUUID || defaultEnvironmentUUID;
    console.log("Message is: ", 2);
    console.log(message, 2);
    return extractBidFromMessage(message)
    .then(extractedBid => {
      extractedBid.roundId = roundId;
      console.log("Extracted bid : ", 2);
      console.log(extractedBid, 2);
      res.json(extractedBid);
    })
    .catch(err => {
      console.log("Error extracting bid: ", 2);
      console.log(err, 2);
      res.json(err);
    });
  }
});

// API route that reports the current utility information.
app.get('/reportUtility', (req, res) => {
  console.log("Inside reportUtility (GET).", 2);
  if(utilityInfo) {
    utilityInfo.roundId = roundId;
    res.json(utilityInfo);
  }
  else {
    res.json({"error": "utilityInfo not initialized."});
  }
});

// Set up the server in the standard Node.js way
http.createServer(app).listen(app.get('port'), () => {
  console.log('Express server listening on port ' + app.get('port'), 2);
});


// ******************************************************************************************************* //
// ******************************************************************************************************* //
//                                               Functions
// ******************************************************************************************************* //
// ******************************************************************************************************* //


// ******************************************************************************************************* //
//                                         Bidding Algorithm Functions                                     //
// ******************************************************************************************************* //


// *** mayIRespond()
// Choose not to respond to certain buy offers or requests, either because the received offer has the wrong role
// or because a different agent is being addressed. Note that this self-censoring is stricter than required
// by competition rules, i.e. this agent is not trying to steal a deal despite this being permitted under the
// right circumstances. You can do better than this!

function mayIRespond(role, addressee) {
  if (polite) {
    return (role == "buyer" && (addressee == agentName || !addressee));
  } else {
    return true;
  }
}

// *** calculateUtilitySeller()
// Calculate utility for a given bundle of goods and price, given the utility function

function calculateUtilitySeller(utilityInfo, bundle) {
  console.log("In calculateUtilitySeller, utilityParams and bundle are: ", 2);
  let utilityParams = utilityInfo.utility;
  console.log(utilityParams, 2);
  console.log(bundle, 2);

  let util = 0;
  let price = getSafe(['price', 'value'], bundle, 0);
  console.log("Extracted price from bundle: " + price, 2);
  if(bundle.quantity) {
    util = price;
    unit = getSafe(['price', 'unit'], bundle, null);
    if(!unit) { // Check units -- not really used, but a good practice in case we want to support currency conversion some day
      console.log("No currency units provided.", 2);
    }
    else if(unit == utilityInfo.currencyUnit) {
      console.log("Currency units match.", 2);
    }
    else {
      console.log("WARNING: Currency units do not match!", 2);
    }
    Object.keys(bundle.quantity).forEach(good => {
      console.log("Good: " + good, 2);
      util -= utilityParams[good].parameters.unitcost * bundle.quantity[good];
    });
  }
  console.log("About to return utility: " + util, 2);
  return util;
}


function generateHaggleBid(offer) {
  console.log("In haggleBid, offer is: ", 2);
  console.log(offer, 2);
  console.log("bid history is currently: ", 3);
  console.log(bidHistory, 3);
  let minDicker = 0.10;
  let buyerName = offer.metadata.speaker;
  let myRecentOffers = bidHistory[buyerName].filter(bidBlock => {
    return (bidBlock.type == "SellOffer");
  });
  console.log("myRecentOffers is: ", 2);
  console.log(myRecentOffers, 2);
  let myLastPrice = null;
  if(myRecentOffers.length) {
    myLastPrice = myRecentOffers[myRecentOffers.length-1].price.value;
    console.log("My most recent price offer was " + myLastPrice, 2);
  }
  let timeRemaining = ((new Date(negotiationState.stopTime)).getTime() - (new Date()).getTime())/ 1000.0;
  console.log("There are " + timeRemaining + " seconds remaining in this round.", 3);

  let utility = calculateUtilitySeller(utilityInfo, offer);
  console.log("From calculateUtilitySeller, utility of offer is computed to be: " + utility, 2);

// Note that we are making no effort to upsell the buyer on a different package of goods than what they requested.
// It would be legal to do so, and perhaps profitable in some situations -- consider doing that!
  let bid = {quantity: offer.quantity};
  let pancakeBundle = {egg: 1, flour: 2, milk: 2};
  let cakeBundle = {egg: 2, flour: 2, milk: 1, sugar: 1};
  let wantedItems = Object.keys(offer.quantity);

  if(offer.price && offer.price.value) { // The buyer included a proposed price, which we must take into account
    let bundleCost = offer.price.value - utility;

    let markupRatio = utility / bundleCost;

    if (markupRatio < -0.5) { // If buyer's offer is substantially below our cost, reject their offer
      bid.type = 'Reject';
      bid.price = null;
    }
    else { // If buyer's offer is in a range where an agreement seems possible, generate a counteroffer
      bid.type = 'SellOffer';
      bid.price = generateSellPrice(bundleCost, offer.price, myLastPrice, timeRemaining);
      if(bid.price.value < offer.price.value + minDicker) {
        bid.type = 'Accept';
        bid.price = offer.price;
      }
      if(bid.price.value > offer.price.value + minDicker) {
        bid.type = 'Reject';
        bid.price = null;
      }
    }
  }
  else { // The buyer didn't include a proposed price, leaving us free to consider how much to charge.
    // Set markup between 2 and 3 times the cost of the bundle and generate price accordingly.
    let wantedAmount = 0;
    if(wantedItems.length === 1){
      wantedAmount =  offer.quantity[wantedItems[0]];
    }
    if(wantedAmount != 0 && wantedAmount % cakeBundle[wantedItems[0]] === 0){//bundle for a cake
      let numCakes = wantedAmount / cakeBundle[wantedItems[0]];
      for(let ingredient in cakeBundle){
        cakeBundle[ingredient] *= numCakes;
      }
      offer.quantity = cakeBundle;
      let bundleUnitPrice = -1.0 * calculateUtilitySeller(utilityInfo, offer);
      console.log("BUNDLE UNIT PRICE IS: " + bundleUnitPrice);
      bid.type = "CakeBundleOffer";
      bid.quantity = cakeBundle;
      bid.price = {
        unit: utilityInfo.currencyUnit,
        value: quantize(1.5 * bundleUnitPrice, 2)
      };
      console.log("RETURNING USER GENED BUNDLE BID");
      console.log(bid);
      return bid;
    }else{//bundle for a pancake

    }
    let markupRatio = 2.0 + Math.random();
    let bundleCost = -1.0 * utility; // Utility is -1 * bundle cost since price is interpreted as 0
    bid.type = 'SellOffer';
    bid.price = {
      unit: utilityInfo.currencyUnit,
      value: quantize(markupRatio * bundleCost, 2)
    };
  }
  console.log("About to return from haggleBid with bid: ", 2);
  console.log(bid, 2);
  return bid;
}
function generateBid(offer) {
  console.log("In generateBid, offer is: ", 2);
  console.log(offer, 2);
  console.log("bid history is currently: ", 3);
  console.log(bidHistory, 3);
  let minDicker = 0.10;
  let buyerName = offer.metadata.speaker;
  let myRecentOffers = bidHistory[buyerName].filter(bidBlock => {
    return (bidBlock.type == "SellOffer");
  });
  console.log("myRecentOffers is: ", 2);
  console.log(myRecentOffers, 2);
  let myLastPrice = null;
  if(myRecentOffers.length) {
    myLastPrice = myRecentOffers[myRecentOffers.length-1].price.value;
    console.log("My most recent price offer was " + myLastPrice, 2);
  }
  let timeRemaining = ((new Date(negotiationState.stopTime)).getTime() - (new Date()).getTime())/ 1000.0;
  console.log("There are " + timeRemaining + " seconds remaining in this round.", 3);

  let utility = calculateUtilitySeller(utilityInfo, offer);
  console.log("From calculateUtilitySeller, utility of offer is computed to be: " + utility, 2);

// Note that we are making no effort to upsell the buyer on a different package of goods than what they requested.
// It would be legal to do so, and perhaps profitable in some situations -- consider doing that!
  let bid = {quantity: offer.quantity};
  let pancakeBundle = {egg: 1, flour: 2, milk: 2};
  let cakeBundle = {egg: 2, flour: 2, milk: 1, sugar: 1};
  let wantedItems = Object.keys(offer.quantity);

  if(offer.price && offer.price.value) { // The buyer included a proposed price, which we must take into account
    let bundleCost = offer.price.value - utility;

    let markupRatio = utility / bundleCost;

    if (markupRatio > 2.0 || (myLastPrice != null && Math.abs(offer.price - myLastPrice) < minDicker)) { // If our markup is large, accept the offer
      bid.type = 'Accept';
      bid.price = offer.price;
    }
    else if (markupRatio < -0.5) { // If buyer's offer is substantially below our cost, reject their offer
      bid.type = 'Reject';
      bid.price = null;
    }
    else { // If buyer's offer is in a range where an agreement seems possible, generate a counteroffer
      bid.type = 'SellOffer';
      bid.price = generateSellPrice(bundleCost, offer.price, myLastPrice, timeRemaining);
      if(bid.price.value < offer.price.value + minDicker) {
        bid.type = 'Accept';
        bid.price = offer.price;
      }
    }
  }
  else { // The buyer didn't include a proposed price, leaving us free to consider how much to charge.
    // Set markup between 2 and 3 times the cost of the bundle and generate price accordingly.
    let wantedAmount = 0;
    if(wantedItems.length === 1){
      wantedAmount =  offer.quantity[wantedItems[0]];
    }
    if(wantedAmount != 0 && wantedAmount % cakeBundle[wantedItems[0]] === 0){//bundle for a cake
      let numCakes = wantedAmount / cakeBundle[wantedItems[0]];
      for(let ingredient in cakeBundle){
        cakeBundle[ingredient] *= numCakes;
      }
      offer.quantity = cakeBundle;
      let bundleUnitPrice = -1.0 * calculateUtilitySeller(utilityInfo, offer);
      console.log("BUNDLE UNIT PRICE IS: " + bundleUnitPrice);
      bid.type = "CakeBundleOffer";
      bid.quantity = cakeBundle;
      bid.price = {
        unit: utilityInfo.currencyUnit,
        value: quantize(1.5 * bundleUnitPrice, 2)
      };
      console.log("RETURNING USER GENED BUNDLE BID");
      console.log(bid);
      return bid;
    }else{//bundle for a pancake

    }
    let markupRatio = 2.0 + Math.random();
    let bundleCost = -1.0 * utility; // Utility is -1 * bundle cost since price is interpreted as 0
    bid.type = 'SellOffer';
    bid.price = {
      unit: utilityInfo.currencyUnit,
      value: quantize(markupRatio * bundleCost, 2)
    };
  }
  console.log("About to return from generateBid with bid: ", 2);
  console.log(bid, 2);
  return bid;
}


// *** generateSellPrice()
// Generate a bid price that is sensitive to cost, negotiation history with this buyer, and time remaining in round

function generateSellPrice(bundleCost, offerPrice, myLastPrice, timeRemaining) {
  console.log("Entered generateSellPrice.", 2);
  console.log("bundleCost: " + bundleCost, 2);
  console.log("offerPrice: ", 2);
  console.log(offerPrice, 2);
  console.log("myLastPrice: " + myLastPrice, 2);
  console.log("timeRemaining: " + timeRemaining, 2);
  let minMarkupRatio;
  let maxMarkupRatio;
  let markupRatio = offerPrice.value/bundleCost - 1.0;
  if(myLastPrice != null) {
    maxMarkupRatio = myLastPrice/bundleCost - 1.0;
  }
  else {
    maxMarkupRatio = 2.0 - 1.5 * (1.0 - timeRemaining/negotiationState.roundDuration); // Linearly decrease max markup ratio towards just 0.5 at the conclusion of the round
  }
  minMarkupRatio = Math.max(markupRatio, 0.20);

  console.log("Min and max markup ratios are: " + minMarkupRatio + " and " + maxMarkupRatio + ".", 2);

  let minProposedMarkup = Math.max(minMarkupRatio, markupRatio);
  let newMarkupRatio = minProposedMarkup + Math.random() * (maxMarkupRatio - minProposedMarkup);

  console.log("newMarkupRatio: " + newMarkupRatio, 2);

  let price = {
    unit: offerPrice.unit,
    value: (1.0 + newMarkupRatio) * bundleCost
  };
  price.value = quantize(price.value, 2);

  console.log("Returning price: ", 2);
  console.log(price, 2);
  return price;
}


// *** processMessage()
// Orchestrate a sequence of
// * classifying the message to obtain and intent and entities
// * interpreting the intents and entities into a structured representation of the message
// * determining (through self-policing) whether rules permit a response to the message
// * generating a bid (or other negotiation act) in response to the offer

function processMessage(message) {
  console.log("In processMessage, message is: ", 2);
  console.log(message, 2);
  return classifyMessage(message)
  .then(classification => {
    classification.environmentUUID = message.environmentUUID;
    console.log("Classification from classify message: ", 2);
    console.log(classification, 2);
    return interpretMessage(classification);
  })
  .then(interpretation => {
    console.log("interpretation is: ", 2);
    console.log(interpretation, 2);
    let speaker = interpretation.metadata.speaker;
    let addressee = interpretation.metadata.addressee;
    let message_speaker_role = interpretation.metadata.role;
    if(speaker == agentName) { // The message was from me; this means that the system allowed it to go through.
      console.log("This message is from me! I'm not going to talk to myself.", 2);
      // If the message from me was an accept or reject, wipe out the bidHistory with this particular negotiation partner
      // Otherwise, add the message to the bid history with this negotiation partner
      if (interpretation.type == 'AcceptOffer' || interpretation.type == 'RejectOffer') {
          bidHistory[addressee] = null;
      }
      else {
        if(bidHistory[addressee]) {
          bidHistory[addressee].push(interpretation);
        }
      }
    }
    else if (message_speaker_role == "buyer") { // Message is from a buyer
      console.log("Interpretation of message: ", 2);
      console.log(interpretation, 2);
      let messageResponse = { // Start forming message, in case I want to send it
        text: "",
        speaker: agentName,
        role: "seller",
        addressee: speaker,
        environmentUUID: interpretation.metadata.environmentUUID,
        timeStamp: new Date()
      };
      if(addressee == agentName && interpretation.type == "AcceptOffer") { // Buyer accepted my offer! Deal with it.
        console.log("The buyer " + speaker + " accepted my offer.", 2);
        console.log(bidHistory, 2);
        if(bidHistory[speaker] && bidHistory[speaker].length) { // I actually did make an offer to this buyer; fetch details and confirm acceptance
          let bidHistoryIndividual = bidHistory[speaker].filter(bid =>
            {return (bid.metadata.speaker == agentName && bid.type == "SellOffer");}
          );
          if (bidHistoryIndividual.length) {
            console.log(bidHistoryIndividual, 2);
            let acceptedBid = bidHistoryIndividual[bidHistoryIndividual.length - 1];
            console.log(acceptedBid, 2);
            bid = {
              price: acceptedBid.price,
              quantity: acceptedBid.quantity,
              type: "Accept"
            };
            console.log(bid, 2);
            messageResponse.text = translateBid(bid, true);
            messageResponse.bid = bid;
            bidHistory[speaker] = null;
          }
          else { // Didn't have any outstanding offers with this buyer
            messageResponse.text = "I'm sorry, but I'm not aware of any outstanding offers.";
          }
        }
        else { // Didn't have any outstanding offers with this buyer
          messageResponse.text = "I'm sorry, but I'm not aware of any outstanding offers.";
        }
        return messageResponse;
      }
      else if (addressee == agentName && interpretation.type == "RejectOffer") { // The buyer claims to be rejecting an offer I made; deal with it
        console.log("My offer was rejected!", 2);
        console.log(bidHistory, 2);
        if(bidHistory[speaker] && bidHistory[speaker].length) { // Check whether I made an offer to this buyer
          let bidHistoryIndividual = bidHistory[speaker].filter(bid =>
            {return (bid.metadata.speaker == agentName && bid.type == "SellOffer");}
          );
          if (bidHistoryIndividual.length) {
            messageResponse.text = "I'm sorry you rejected my bid. I hope we can do business in the near future.";
            bidHistory[speaker] = null;
          }
          else {
            messageResponse.text = "There must be some confusion; I'm not aware of any outstanding offers.";
          }
        }
        else {
          messageResponse.text = "OK, but I didn't think we had any outstanding offers.";
        }
        return messageResponse;
      }
      else if(addressee == agentName && interpretation.type == "Haggle"){ // The buyer is informing me that they want to haggle the price
        
        if(mayIRespond(message_speaker_role, addressee)) { // I'm going to let myself respond, as dictated by mayIRespond()

          if(!bidHistory[speaker]) bidHistory[speaker] = [];
          bidHistory[speaker].push(interpretation);

          let bid = generateHaggleBid(interpretation); // Generate bid based on message interpretation, utility, and the current state of negotiation with the buyer
          console.log("Proposed bid is: ", 2);
          console.log(bid, 2);

          let bidResponse = {
            text: translateBid(bid, false), // Translate the bid into English
            speaker: agentName,
            role: "seller",
            addressee: speaker,
            environmentUUID: interpretation.metadata.environmentUUID,
            timeStamp: new Date()
          };
          bidResponse.bid = bid;

          return bidResponse;
        }
        else { // Message was from a buyer, but I'm voluntarily opting not to respond, as dictated by mayIRespond()
          console.log("I'm choosing not to do respond to this haggle request.", 2);
          console.log(message, 2);
          return Promise.resolve(null);
        }
      }
      else if (addressee == agentName && interpretation.type == "Information") { // The buyer is just sending me an informational message. Reply politely without attempting to understand.
        console.log("This is an informational message.", 2);
        let messageResponse = {
          text: "OK. Thanks for letting me know.",
          speaker: agentName,
          role: "seller",
          addressee: speaker,
          environmentUUID: interpretation.metadata.environmentUUID,
          timeStamp: new Date()
        };
        return messageResponse;
      }
      else if (addressee == agentName && interpretation.type == "NotUnderstood") { // The buyer said something, but we can't figure out what they meant. Just ignore them and hope they'll try again if it's important.
        console.log("I didn't understand this message; pretend it never happened.", 2);
        return Promise.resolve(null);
      }
      else if(interpretation.type == "BuyOffer" ||
               interpretation.type == "BuyRequest") { // The buyer is making an offer or a request
        if(mayIRespond(message_speaker_role, addressee)) { // I'm going to let myself respond, as dictated by mayIRespond()

          if(!bidHistory[speaker]) bidHistory[speaker] = [];
          bidHistory[speaker].push(interpretation);

          let bid = generateBid(interpretation); // Generate bid based on message interpretation, utility, and the current state of negotiation with the buyer
          console.log("Proposed bid is: ", 2);
          console.log(bid, 2);

          let bidResponse = {
            text: translateBid(bid, false), // Translate the bid into English
            speaker: agentName,
            role: "seller",
            addressee: speaker,
            environmentUUID: interpretation.metadata.environmentUUID,
            timeStamp: new Date()
          };
          bidResponse.bid = bid;

          return bidResponse;
        }
        else { // Message was from a buyer, but I'm voluntarily opting not to respond, as dictated by mayIRespond()
          console.log("I'm choosing not to do respond to this buy offer or request.", 2);
          console.log(message, 2);
          return Promise.resolve(null);
        }
      }
      else { // None of the specific cases are satisfied; don't take any action
        return Promise.resolve(null);
      }
    }
    else if(message_speaker_role == "seller") { // Message was from another seller. A more clever agent might be able to exploit this info somehow!
      console.log("The other seller, " + speaker + ", sent this message: ", 2);
      console.log(message, 2);
      return Promise.resolve(null);
    }
  })
  .catch(error => {
    console.log("Encountered error in processMessage: ", 1);
    console.log(error, 1);
    return Promise.resolve(null);
  });
}


// ******************************************************************************************************* //
//                                                     Simple Utilities                                    //
// ******************************************************************************************************* //

// *** quantize()
// Quantize numeric quantity to desired number of decimal digits
// Useful for making sure that bid prices don't get more fine-grained than cents
function quantize(quantity, decimals) {
  let multiplicator = Math.pow(10, decimals);
  let q = parseFloat((quantity * multiplicator).toFixed(11));
  return Math.round(q) / multiplicator;
}


// *** getSafe()
// Utility that retrieves a specified piece of a JSON structure safely.
// o: the JSON structure from which a piece needs to be extracted, e.g. bundle
// p: list specifying the desired part of the JSON structure, e.g.['price', 'value'] to retrieve bundle.price.value
// d: default value, in case the desired part does not exist.

function getSafe(p, o, d) {
  return p.reduce((xs, x) => (xs && xs[x] != null && xs[x] != undefined) ? xs[x] : d, o);
}


// ******************************************************************************************************* //
//                                                    Messaging                                            //
// ******************************************************************************************************* //


// *** translateBid()
// Translate structured bid to text, with some randomization

function translateBid(bid, confirm) {
  let text = "";
  let size = 0;
  if(bid.type == 'SellOffer') {
    text = "How about if I sell you";
    Object.keys(bid.quantity).forEach(good => {
      text += " " + bid.quantity[good] + " " + good; 
      size++; 
    });
    text += " for " + bid.price.value + " " + bid.price.unit + ". ";
    if(size > 1){
      text += selectMessage(multiMessages);
    }
    else{
      Object.keys(bid.quantity).forEach(good => {
        if(good == "egg"){
          text += selectMessage(eggMessages); 
        }
        else if(good == "flour"){
          text += selectMessage(flourMessages);
        }
        else if(good == "milk"){
          text += selectMessage(milkMessages); 
        }
        else if(good == "sugar"){
          text += selectMessage(sugarMessages);
        }
        else if(good == "chocolate"){
          text += selectMessage(chocolateMessages);
        }
        else if(good == "vanilla"){
          text += selectMessage(vanillaMessages); 
        }
        else if(good == "blueberry"){
          text += selectMessage(blueberryMessages);
        }
      });
    }
  }
  else if (bid.type == "CakeBundleOffer"){
    text = "Why not bundle that into ";
    text += (bid.quantity['egg'] / 2) + " cakes."
    text +=" In total I'll sell you"
    Object.keys(bid.quantity).forEach(good => {
      text += " " + bid.quantity[good] + " " + good;
    });
    text += " for " + bid.price.value + " " + bid.price.unit + ".";
  }
  else if(bid.type == 'Reject') {
    text = selectMessage(rejectionMessages);
  }
  else if(bid.type == 'Accept') {
    if(confirm) {
      text = selectMessage(confirmAcceptanceMessages);
    }
    else {
      text = selectMessage(acceptanceMessages);
    }
    Object.keys(bid.quantity).forEach(good => {
      text += " " + bid.quantity[good] + " " + good;
    });
    text += " for " + bid.price.value + " " + bid.price.unit + ".";
  }
  return text;
}


// *** selectMessage()
// Randomly select a message or phrase from a specified set

function selectMessage(messageSet) {
  let msgSetSize = messageSet.length;
  let indx = parseInt(Math.random() * msgSetSize);
  return messageSet[indx];
}


// *** sendMessage()
// Send specified message to the /receiveMessage route of the environment orchestrator

function sendMessage(message) {
  message.roundId = roundId;
  console.log("Sending message to environment orchestrator: ", 2);
  console.log(message, 2);
  return postDataToServiceType(message, 'environment-orchestrator', '/relayMessage');
}


// *** postDataToServiceType()
// POST a given json to a service type; mappings to host:port are externalized in the appSettings.json file

function postDataToServiceType(json, serviceType, path) {
  let serviceMap = appSettings.serviceMap;
  if(serviceMap[serviceType]) {
    let options = serviceMap[serviceType];
    options.path = path;
    let url = options2URL(options);
    let rOptions = {
      method: 'POST',
      uri: url,
      body: json,
      json: true
    };
    return request(rOptions)
    .then(response => {
      return response;
    })
    .catch(error => {
      console.log("Error: ", 1);
      console.log(error, 1);
      return null;
    });
  }
}


// *** options2URL()
// Convert host, port, path to URL

function options2URL(options) {
  let protocol = options.protocol || 'http';
  let url = protocol + '://' + options.host;
  if (options.port) url += ':' + options.port;
  if (options.path) url  += options.path;
  return url;
}

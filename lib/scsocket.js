var Emitter = require('component-emitter');
var SCChannel = require('sc-channel').SCChannel;
var Response = require('./response').Response;
var AuthEngine = require('./auth').AuthEngine;
var formatter = require('sc-formatter');
var SCTransport = require('./sctransport').SCTransport;
var querystring = require('querystring');
var LinkedList = require('linked-list');
var base64 = require('base-64');
var clone = require('clone');

var scErrors = require('sc-errors');
var InvalidArgumentsError = scErrors.InvalidArgumentsError;
var InvalidMessageError = scErrors.InvalidMessageError;
var SocketProtocolError = scErrors.SocketProtocolError;
var TimeoutError = scErrors.TimeoutError;
var BadConnectionError = scErrors.BadConnectionError;

var isBrowser = typeof window != 'undefined';


var SCSocket = function (opts) {
  var self = this;

  Emitter.call(this);

  this.id = null;
  this.state = this.CLOSED;
  this.authState = this.UNAUTHENTICATED;
  this.signedAuthToken = null;
  this.authToken = null;
  this.pendingReconnect = false;
  this.pendingReconnectTimeout = null;
  this.preparingPendingSubscriptions = false;
  this.clientId = opts.clientId;

  this.connectTimeout = opts.connectTimeout;
  this.ackTimeout = opts.ackTimeout;
  this.channelPrefix = opts.channelPrefix || null;
  this.disconnectOnUnload = opts.disconnectOnUnload == null ? true : opts.disconnectOnUnload;
  this.authTokenName = opts.authTokenName;

  // pingTimeout will be ackTimeout at the start, but it will
  // be updated with values provided by the 'connect' event
  this.pingTimeout = this.ackTimeout;

  this._clientMap = opts.clientMap || {};

  var maxTimeout = Math.pow(2, 31) - 1;

  var verifyDuration = function (propertyName) {
    if (self[propertyName] > maxTimeout) {
      throw new InvalidArgumentsError('The ' + propertyName +
        ' value provided exceeded the maximum amount allowed');
    }
  };

  verifyDuration('connectTimeout');
  verifyDuration('ackTimeout');
  verifyDuration('pingTimeout');

  this._localEvents = {
    'connect': 1,
    'connectAbort': 1,
    'close': 1,
    'disconnect': 1,
    'message': 1,
    'error': 1,
    'raw': 1,
    'fail': 1,
    'kickOut': 1,
    'subscribe': 1,
    'unsubscribe': 1,
    'subscribeStateChange': 1,
    'authStateChange': 1,
    'authenticate': 1,
    'deauthenticate': 1,
    'removeAuthToken': 1,
    'subscribeRequest': 1
  };

  this.connectAttempts = 0;

  this._emitBuffer = new LinkedList();
  this.channels = {};

  this.options = opts;

  this._cid = 1;

  this.options.callIdGenerator = function () {
    return self._cid++;
  };

  if (this.options.autoReconnect) {
    if (this.options.autoReconnectOptions == null) {
      this.options.autoReconnectOptions = {};
    }

    // Add properties to the this.options.autoReconnectOptions object.
    // We assign the reference to a reconnectOptions variable to avoid repetition.
    var reconnectOptions = this.options.autoReconnectOptions;
    if (reconnectOptions.initialDelay == null) {
      reconnectOptions.initialDelay = 10000;
    }
    if (reconnectOptions.randomness == null) {
      reconnectOptions.randomness = 10000;
    }
    if (reconnectOptions.multiplier == null) {
      reconnectOptions.multiplier = 1.5;
    }
    if (reconnectOptions.maxDelay == null) {
      reconnectOptions.maxDelay = 60000;
    }
  }

  if (this.options.subscriptionRetryOptions == null) {
    this.options.subscriptionRetryOptions = {};
  }

  if (this.options.authEngine) {
    this.auth = this.options.authEngine;
  } else {
    this.auth = new AuthEngine();
  }

  if (this.options.codecEngine) {
    this.codec = this.options.codecEngine;
  } else {
    // Default codec engine
    this.codec = formatter;
  }

  this.options.path = this.options.path.replace(/\/$/, '') + '/';

  this.options.query = opts.query || {};
  if (typeof this.options.query == 'string') {
    this.options.query = querystring.parse(this.options.query);
  }

  if (this.options.autoConnect) {
    this.connect();
  }

  this._channelEmitter = new Emitter();

  if (isBrowser && this.disconnectOnUnload && global.addEventListener) {
    this._unloadHandler = function () {
      self.disconnect();
    };

    global.addEventListener('beforeunload', this._unloadHandler, false);
  }
};

SCSocket.prototype = Object.create(Emitter.prototype);

SCSocket.CONNECTING = SCSocket.prototype.CONNECTING = SCTransport.prototype.CONNECTING;
SCSocket.OPEN = SCSocket.prototype.OPEN = SCTransport.prototype.OPEN;
SCSocket.CLOSED = SCSocket.prototype.CLOSED = SCTransport.prototype.CLOSED;

SCSocket.AUTHENTICATED = SCSocket.prototype.AUTHENTICATED = 'authenticated';
SCSocket.UNAUTHENTICATED = SCSocket.prototype.UNAUTHENTICATED = 'unauthenticated';

SCSocket.PENDING = SCSocket.prototype.PENDING = 'pending';

SCSocket.ignoreStatuses = scErrors.socketProtocolIgnoreStatuses;
SCSocket.errorStatuses = scErrors.socketProtocolErrorStatuses;

SCSocket.prototype._privateEventHandlerMap = {
  '#publish': function (data) {
    var undecoratedChannelName = this._undecorateChannelName(data.channel);
    var isSubscribed = this.isSubscribed(undecoratedChannelName, true);

    if (isSubscribed) {
      this._channelEmitter.emit(undecoratedChannelName, data.data);
    }
  },
  '#kickOut': function (data) {
    var undecoratedChannelName = this._undecorateChannelName(data.channel);
    var channel = this.channels[undecoratedChannelName];
    if (channel) {
      Emitter.prototype.emit.call(this, 'kickOut', data.message, undecoratedChannelName);
      channel.emit('kickOut', data.message, undecoratedChannelName);
      this._triggerChannelUnsubscribe(channel);
    }
  },
  '#setAuthToken': function (data, response) {
    var self = this;

    if (data) {
      var triggerAuthenticate = function (err) {
        if (err) {
          // This is a non-fatal error, we don't want to close the connection
          // because of this but we do want to notify the server and throw an error
          // on the client.
          response.error(err);
          self._onSCError(err);
        } else {
          self._changeToAuthenticatedState(data.token);
          response.end();
        }
      };

      this.auth.saveToken(this.authTokenName, data.token, {}, triggerAuthenticate);
    } else {
      response.error(new InvalidMessageError('No token data provided by #setAuthToken event'));
    }
  },
  '#removeAuthToken': function (data, response) {
    var self = this;

    this.auth.removeToken(this.authTokenName, function (err, oldToken) {
      if (err) {
        // Non-fatal error - Do not close the connection
        response.error(err);
        self._onSCError(err);
      } else {
        Emitter.prototype.emit.call(self, 'removeAuthToken', oldToken);
        self._changeToUnauthenticatedStateAndClearTokens();
        response.end();
      }
    });
  },
  '#disconnect': function (data) {
    this.transport.close(data.code, data.data);
  }
};

SCSocket.prototype.getState = function () {
  return this.state;
};

SCSocket.prototype.getBytesReceived = function () {
  return this.transport.getBytesReceived();
};

SCSocket.prototype.deauthenticate = function (callback) {
  var self = this;

  this.auth.removeToken(this.authTokenName, function (err, oldToken) {
    if (err) {
      // Non-fatal error - Do not close the connection
      self._onSCError(err);
    } else {
      Emitter.prototype.emit.call(self, 'removeAuthToken', oldToken);
      if (self.state != self.CLOSED) {
        self.emit('#removeAuthToken');
      }
      self._changeToUnauthenticatedStateAndClearTokens();
    }
    callback && callback(err);
  });
};

SCSocket.prototype.connect = SCSocket.prototype.open = function () {
  var self = this;

  if (this.state == this.CLOSED) {
    this.pendingReconnect = false;
    this.pendingReconnectTimeout = null;
    clearTimeout(this._reconnectTimeoutRef);

    this.state = this.CONNECTING;
    Emitter.prototype.emit.call(this, 'connecting');

    if (this.transport) {
      this.transport.off();
    }

    this.transport = new SCTransport(this.auth, this.codec, this.options);

    this.transport.on('open', function (status) {
      self.state = self.OPEN;
      self._onSCOpen(status);
    });

    this.transport.on('error', function (err) {
      self._onSCError(err);
    });

    this.transport.on('close', function (code, data) {
      self.state = self.CLOSED;
      self._onSCClose(code, data);
    });

    this.transport.on('openAbort', function (code, data) {
      self.state = self.CLOSED;
      self._onSCClose(code, data, true);
    });

    this.transport.on('event', function (event, data, res) {
      self._onSCEvent(event, data, res);
    });
  }
};

SCSocket.prototype.reconnect = function () {
  this.disconnect();
  this.connect();
};

SCSocket.prototype.disconnect = function (code, data) {
  code = code || 1000;

  if (typeof code != 'number') {
    throw new InvalidArgumentsError('If specified, the code argument must be a number');
  }

  if (this.state == this.OPEN || this.state == this.CONNECTING) {
    this.transport.close(code, data);
  } else {
    this.pendingReconnect = false;
    this.pendingReconnectTimeout = null;
    clearTimeout(this._reconnectTimeoutRef);
  }
};

SCSocket.prototype.destroy = function () {
  if (this._unloadHandler) {
    global.removeEventListener('beforeunload', this._unloadHandler, false);
  }
  this.disconnect();
  delete this._clientMap[this.clientId];
};

SCSocket.prototype._changeToUnauthenticatedStateAndClearTokens = function () {
  if (this.authState != this.UNAUTHENTICATED) {
    var oldState = this.authState;
    this.authState = this.UNAUTHENTICATED;
    this.signedAuthToken = null;
    this.authToken = null;

    var stateChangeData = {
      oldState: oldState,
      newState: this.authState
    };
    Emitter.prototype.emit.call(this, 'authStateChange', stateChangeData);
    if (oldState == this.AUTHENTICATED) {
      Emitter.prototype.emit.call(this, 'deauthenticate');
    }
    Emitter.prototype.emit.call(this, 'authTokenChange', this.signedAuthToken);
  }
};

SCSocket.prototype._changeToAuthenticatedState = function (signedAuthToken) {
  this.signedAuthToken = signedAuthToken;
  this.authToken = this._extractAuthTokenData(signedAuthToken);

  if (this.authState != this.AUTHENTICATED) {
    var oldState = this.authState;
    this.authState = this.AUTHENTICATED;
    var stateChangeData = {
      oldState: oldState,
      newState: this.authState,
      signedAuthToken: signedAuthToken,
      authToken: this.authToken
    };
    if (!this.preparingPendingSubscriptions) {
      this.processPendingSubscriptions();
    }

    Emitter.prototype.emit.call(this, 'authStateChange', stateChangeData);
    Emitter.prototype.emit.call(this, 'authenticate', signedAuthToken);
  }
  Emitter.prototype.emit.call(this, 'authTokenChange', signedAuthToken);
};

SCSocket.prototype.decodeBase64 = function (encodedString) {
  var decodedString;
  if (typeof Buffer == 'undefined') {
    if (global.atob) {
      decodedString = global.atob(encodedString);
    } else {
      decodedString = base64.decode(encodedString);
    }
  } else {
    var buffer = new Buffer(encodedString, 'base64');
    decodedString = buffer.toString('utf8');
  }
  return decodedString;
};

SCSocket.prototype.encodeBase64 = function (decodedString) {
  var encodedString;
  if (typeof Buffer == 'undefined') {
    if (global.btoa) {
      encodedString = global.btoa(decodedString);
    } else {
      encodedString = base64.encode(decodedString);
    }
  } else {
    var buffer = new Buffer(decodedString, 'utf8');
    encodedString = buffer.toString('base64');
  }
  return encodedString;
};

SCSocket.prototype._extractAuthTokenData = function (signedAuthToken) {
  var tokenParts = (signedAuthToken || '').split('.');
  var encodedTokenData = tokenParts[1];
  if (encodedTokenData != null) {
    var tokenData = encodedTokenData;
    try {
      tokenData = this.decodeBase64(tokenData);
      return JSON.parse(tokenData);
    } catch (e) {
      return tokenData;
    }
  }
  return null;
};

SCSocket.prototype.getAuthToken = function () {
  return this.authToken;
};

SCSocket.prototype.getSignedAuthToken = function () {
  return this.signedAuthToken;
};

// Perform client-initiated authentication by providing an encrypted token string.
SCSocket.prototype.authenticate = function (signedAuthToken, callback) {
  var self = this;

  this.emit('#authenticate', signedAuthToken, function (err, authStatus) {

    if (authStatus && authStatus.isAuthenticated != null) {
      // If authStatus is correctly formatted (has an isAuthenticated property),
      // then we will rehydrate the authError.
      if (authStatus.authError) {
        authStatus.authError = scErrors.hydrateError(authStatus.authError);
      }
    } else {
      // Some errors like BadConnectionError and TimeoutError will not pass a valid
      // authStatus object to the current function, so we need to create it ourselves.
      authStatus = {
        isAuthenticated: self.authState,
        authError: null
      };
    }
    if (err) {
      if (err.name != 'BadConnectionError' && err.name != 'TimeoutError') {
        // In case of a bad/closed connection or a timeout, we maintain the last
        // known auth state since those errors don't mean that the token is invalid.

        self._changeToUnauthenticatedStateAndClearTokens();
      }
      callback && callback(err, authStatus);
    } else {
      self.auth.saveToken(self.authTokenName, signedAuthToken, {}, function (err) {
        if (err) {
          self._onSCError(err);
        }
        if (authStatus.isAuthenticated) {
          self._changeToAuthenticatedState(signedAuthToken);
        } else {
          self._changeToUnauthenticatedStateAndClearTokens();
        }
        callback && callback(err, authStatus);
      });
    }
  });
};

SCSocket.prototype._tryReconnect = function (initialDelay) {
  var self = this;

  var exponent = this.connectAttempts++;
  var reconnectOptions = this.options.autoReconnectOptions;
  var timeout;

  if (initialDelay == null || exponent > 0) {
    var initialTimeout = Math.round(reconnectOptions.initialDelay + (reconnectOptions.randomness || 0) * Math.random());

    timeout = Math.round(initialTimeout * Math.pow(reconnectOptions.multiplier, exponent));
  } else {
    timeout = initialDelay;
  }

  if (timeout > reconnectOptions.maxDelay) {
    timeout = reconnectOptions.maxDelay;
  }

  clearTimeout(this._reconnectTimeoutRef);

  this.pendingReconnect = true;
  this.pendingReconnectTimeout = timeout;
  this._reconnectTimeoutRef = setTimeout(function () {
    self.connect();
  }, timeout);
};

SCSocket.prototype._onSCOpen = function (status) {
  var self = this;

  this.preparingPendingSubscriptions = true;

  if (status) {
    this.id = status.id;
    this.pingTimeout = status.pingTimeout;
    this.transport.pingTimeout = this.pingTimeout;
    if (status.isAuthenticated) {
      this._changeToAuthenticatedState(status.authToken);
    } else {
      this._changeToUnauthenticatedStateAndClearTokens();
    }
  } else {
    // This can happen if auth.loadToken (in sctransport.js) fails with
    // an error - This means that the signedAuthToken cannot be loaded by
    // the auth engine and therefore, we need to unauthenticate the socket.
    this._changeToUnauthenticatedStateAndClearTokens();
  }

  this.connectAttempts = 0;

  if (this.options.autoSubscribeOnConnect) {
    this.processPendingSubscriptions();
  }

  // If the user invokes the callback while in autoSubscribeOnConnect mode, it
  // won't break anything.
  Emitter.prototype.emit.call(this, 'connect', status, function () {
    self.processPendingSubscriptions();
  });

  this._flushEmitBuffer();
};

SCSocket.prototype._onSCError = function (err) {
  var self = this;

  // Throw error in different stack frame so that error handling
  // cannot interfere with a reconnect action.
  setTimeout(function () {
    if (self.listeners('error').length < 1) {
      throw err;
    } else {
      Emitter.prototype.emit.call(self, 'error', err);
    }
  }, 0);
};

SCSocket.prototype._suspendSubscriptions = function () {
  var channel, newState;
  for (var channelName in this.channels) {
    if (this.channels.hasOwnProperty(channelName)) {
      channel = this.channels[channelName];
      if (channel.state == channel.SUBSCRIBED ||
        channel.state == channel.PENDING) {

        newState = channel.PENDING;
      } else {
        newState = channel.UNSUBSCRIBED;
      }

      this._triggerChannelUnsubscribe(channel, newState);
    }
  }
};

SCSocket.prototype._abortAllPendingEventsDueToBadConnection = function (failureType) {
  var currentNode = this._emitBuffer.head;
  var nextNode;

  while (currentNode) {
    nextNode = currentNode.next;
    var eventObject = currentNode.data;
    clearTimeout(eventObject.timeout);
    delete eventObject.timeout;
    currentNode.detach();
    currentNode = nextNode;

    var callback = eventObject.callback;
    if (callback) {
      delete eventObject.callback;
      var errorMessage = "Event '" + eventObject.event +
        "' was aborted due to a bad connection";
      var error = new BadConnectionError(errorMessage, failureType);
      callback.call(eventObject, error, eventObject);
    }
    // Cleanup any pending response callback in the transport layer too.
    if (eventObject.cid) {
      this.transport.cancelPendingResponse(eventObject.cid);
    }
  }
};

SCSocket.prototype._onSCClose = function (code, data, openAbort) {
  var self = this;

  this.id = null;

  if (this.transport) {
    this.transport.off();
  }
  this.pendingReconnect = false;
  this.pendingReconnectTimeout = null;
  clearTimeout(this._reconnectTimeoutRef);

  this._suspendSubscriptions();
  this._abortAllPendingEventsDueToBadConnection(openAbort ? 'connectAbort' : 'disconnect');

  // Try to reconnect
  // on server ping timeout (4000)
  // or on client pong timeout (4001)
  // or on close without status (1005)
  // or on handshake failure (4003)
  // or on handshake rejection (4008)
  // or on socket hung up (1006)
  if (this.options.autoReconnect) {
    if (code == 4000 || code == 4001 || code == 1005) {
      // If there is a ping or pong timeout or socket closes without
      // status, don't wait before trying to reconnect - These could happen
      // if the client wakes up after a period of inactivity and in this case we
      // want to re-establish the connection as soon as possible.
      this._tryReconnect(0);

      // Codes 4500 and above will be treated as permanent disconnects.
      // Socket will not try to auto-reconnect.
    } else if (code != 1000 && code < 4500) {
      this._tryReconnect();
    }
  }

  if (openAbort) {
    Emitter.prototype.emit.call(self, 'connectAbort', code, data);
  } else {
    Emitter.prototype.emit.call(self, 'disconnect', code, data);
  }
  Emitter.prototype.emit.call(self, 'close', code, data);

  if (!SCSocket.ignoreStatuses[code]) {
    var closeMessage;
    if (data) {
      closeMessage = 'Socket connection closed with status code ' + code + ' and reason: ' + data;
    } else {
      closeMessage = 'Socket connection closed with status code ' + code;
    }
    var err = new SocketProtocolError(SCSocket.errorStatuses[code] || closeMessage, code);
    this._onSCError(err);
  }
};

SCSocket.prototype._onSCEvent = function (event, data, res) {
  var handler = this._privateEventHandlerMap[event];
  if (handler) {
    handler.call(this, data, res);
  } else {
    Emitter.prototype.emit.call(this, event, data, function () {
      res && res.callback.apply(res, arguments);
    });
  }
};

SCSocket.prototype.decode = function (message) {
  return this.transport.decode(message);
};

SCSocket.prototype.encode = function (object) {
  return this.transport.encode(object);
};

SCSocket.prototype._flushEmitBuffer = function () {
  var currentNode = this._emitBuffer.head;
  var nextNode;

  while (currentNode) {
    nextNode = currentNode.next;
    var eventObject = currentNode.data;
    currentNode.detach();
    this.transport.emitObject(eventObject);
    currentNode = nextNode;
  }
};

SCSocket.prototype._handleEventAckTimeout = function (eventObject, eventNode) {
  if (eventNode) {
    eventNode.detach();
  }
  delete eventObject.timeout;

  var callback = eventObject.callback;
  if (callback) {
    delete eventObject.callback;
    var error = new TimeoutError("Event response for '" + eventObject.event + "' timed out");
    callback.call(eventObject, error, eventObject);
  }
  // Cleanup any pending response callback in the transport layer too.
  if (eventObject.cid) {
    this.transport.cancelPendingResponse(eventObject.cid);
  }
};

SCSocket.prototype._emit = function (event, data, callback) {
  var self = this;

  if (this.state == this.CLOSED) {
    this.connect();
  }
  var eventObject = {
    event: event,
    callback: callback
  };

  var eventNode = new LinkedList.Item();

  if (this.options.cloneData) {
    eventObject.data = clone(data);
  } else {
    eventObject.data = data;
  }
  eventNode.data = eventObject;

  eventObject.timeout = setTimeout(function () {
    self._handleEventAckTimeout(eventObject, eventNode);
  }, this.ackTimeout);

  this._emitBuffer.append(eventNode);

  if (this.state == this.OPEN) {
    this._flushEmitBuffer();
  }
};

SCSocket.prototype.send = function (data) {
  this.transport.send(data);
};

SCSocket.prototype.emit = function (event, data, callback) {
  if (this._localEvents[event] == null) {
    this._emit(event, data, callback);
  } else {
    Emitter.prototype.emit.call(this, event, data);
  }
};

SCSocket.prototype.publish = function (channelName, data, callback) {
  var pubData = {
    channel: this._decorateChannelName(channelName),
    data: data
  };
  this.emit('#publish', pubData, callback);
};

SCSocket.prototype._triggerChannelSubscribe = function (channel, subscriptionOptions) {
  var channelName = channel.name;

  if (channel.state != channel.SUBSCRIBED) {
    var oldState = channel.state;
    channel.state = channel.SUBSCRIBED;

    var stateChangeData = {
      channel: channelName,
      oldState: oldState,
      newState: channel.state,
      subscriptionOptions: subscriptionOptions
    };
    channel.emit('subscribeStateChange', stateChangeData);
    channel.emit('subscribe', channelName, subscriptionOptions);
    Emitter.prototype.emit.call(this, 'subscribeStateChange', stateChangeData);
    Emitter.prototype.emit.call(this, 'subscribe', channelName, subscriptionOptions);
  }
};

SCSocket.prototype._triggerChannelSubscribeFail = function (err, channel, subscriptionOptions) {
  var channelName = channel.name;
  var meetsAuthRequirements = !channel.waitForAuth || this.authState == this.AUTHENTICATED;

  if (channel.state != channel.UNSUBSCRIBED && meetsAuthRequirements) {
    channel.state = channel.UNSUBSCRIBED;

    channel.emit('subscribeFail', err, channelName, subscriptionOptions);
    Emitter.prototype.emit.call(this, 'subscribeFail', err, channelName, subscriptionOptions);
  }
};

// Cancel any pending subscribe callback
SCSocket.prototype._cancelPendingSubscribeCallback = function (channel) {
  if (channel._pendingSubscriptionCid != null) {
    this.transport.cancelPendingResponse(channel._pendingSubscriptionCid);
    delete channel._pendingSubscriptionCid;
  }
};

SCSocket.prototype._decorateChannelName = function (channelName) {
  if (this.channelPrefix) {
    channelName = this.channelPrefix + channelName;
  }
  return channelName;
};

SCSocket.prototype._undecorateChannelName = function (decoratedChannelName) {
  if (this.channelPrefix && decoratedChannelName.indexOf(this.channelPrefix) == 0) {
    return decoratedChannelName.replace(this.channelPrefix, '');
  }
  return decoratedChannelName;
};

SCSocket.prototype._trySubscribe = function (channel) {
  var self = this;

  var meetsAuthRequirements = !channel.waitForAuth || this.authState == this.AUTHENTICATED;

  // We can only ever have one pending subscribe action at any given time on a channel
  if (this.state == this.OPEN && !this.preparingPendingSubscriptions &&
    channel._pendingSubscriptionCid == null && meetsAuthRequirements) {

    var options = {
      noTimeout: true
    };

    var subscriptionOptions = {
      channel: this._decorateChannelName(channel.name)
    };
    if (channel.waitForAuth) {
      options.waitForAuth = true;
      subscriptionOptions.waitForAuth = options.waitForAuth;
    }
    if (channel.data) {
      subscriptionOptions.data = channel.data;
    }
    if (channel.batch) {
      options.batch = true;
      subscriptionOptions.batch = true;
    }

    channel._pendingSubscriptionCid = this.transport.emit(
      '#subscribe', subscriptionOptions, options,
      function (err) {
        delete channel._pendingSubscriptionCid;
        if (err) {
          self._triggerChannelSubscribeFail(err, channel, subscriptionOptions);
        } else {
          self._triggerChannelSubscribe(channel, subscriptionOptions);
        }
      }
    );
    Emitter.prototype.emit.call(this, 'subscribeRequest', channel.name, subscriptionOptions);
  }
};

SCSocket.prototype.subscribe = function (channelName, options) {
  var channel = this.channels[channelName];

  if (!channel) {
    channel = new SCChannel(channelName, this, options);
    this.channels[channelName] = channel;
  } else if (options) {
    channel.setOptions(options);
  }

  if (channel.state == channel.UNSUBSCRIBED) {
    channel.state = channel.PENDING;
    this._trySubscribe(channel);
  }

  return channel;
};

SCSocket.prototype._triggerChannelUnsubscribe = function (channel, newState) {
  var channelName = channel.name;
  var oldState = channel.state;

  if (newState) {
    channel.state = newState;
  } else {
    channel.state = channel.UNSUBSCRIBED;
  }
  this._cancelPendingSubscribeCallback(channel);

  if (oldState == channel.SUBSCRIBED) {
    var stateChangeData = {
      channel: channelName,
      oldState: oldState,
      newState: channel.state
    };
    channel.emit('subscribeStateChange', stateChangeData);
    channel.emit('unsubscribe', channelName);
    Emitter.prototype.emit.call(this, 'subscribeStateChange', stateChangeData);
    Emitter.prototype.emit.call(this, 'unsubscribe', channelName);
  }
};

SCSocket.prototype._tryUnsubscribe = function (channel) {
  var self = this;

  if (this.state == this.OPEN) {
    var options = {
      noTimeout: true
    };
    if (channel.batch) {
      options.batch = true;
    }
    // If there is a pending subscribe action, cancel the callback
    this._cancelPendingSubscribeCallback(channel);

    // This operation cannot fail because the TCP protocol guarantees delivery
    // so long as the connection remains open. If the connection closes,
    // the server will automatically unsubscribe the socket and thus complete
    // the operation on the server side.
    var decoratedChannelName = this._decorateChannelName(channel.name);
    this.transport.emit('#unsubscribe', decoratedChannelName, options);
  }
};

SCSocket.prototype.unsubscribe = function (channelName) {

  var channel = this.channels[channelName];

  if (channel) {
    if (channel.state != channel.UNSUBSCRIBED) {

      this._triggerChannelUnsubscribe(channel);
      this._tryUnsubscribe(channel);
    }
  }
};

SCSocket.prototype.channel = function (channelName, options) {
  var currentChannel = this.channels[channelName];

  if (!currentChannel) {
    currentChannel = new SCChannel(channelName, this, options);
    this.channels[channelName] = currentChannel;
  }
  return currentChannel;
};

SCSocket.prototype.destroyChannel = function (channelName) {
  var channel = this.channels[channelName];
  channel.unwatch();
  channel.unsubscribe();
  delete this.channels[channelName];
};

SCSocket.prototype.subscriptions = function (includePending) {
  var subs = [];
  var channel, includeChannel;
  for (var channelName in this.channels) {
    if (this.channels.hasOwnProperty(channelName)) {
      channel = this.channels[channelName];

      if (includePending) {
        includeChannel = channel && (channel.state == channel.SUBSCRIBED ||
          channel.state == channel.PENDING);
      } else {
        includeChannel = channel && channel.state == channel.SUBSCRIBED;
      }

      if (includeChannel) {
        subs.push(channelName);
      }
    }
  }
  return subs;
};

SCSocket.prototype.isSubscribed = function (channelName, includePending) {
  var channel = this.channels[channelName];
  if (includePending) {
    return !!channel && (channel.state == channel.SUBSCRIBED ||
      channel.state == channel.PENDING);
  }
  return !!channel && channel.state == channel.SUBSCRIBED;
};

SCSocket.prototype.processPendingSubscriptions = function () {
  var self = this;

  this.preparingPendingSubscriptions = false;

  var pendingChannels = [];

  for (var i in this.channels) {
    if (this.channels.hasOwnProperty(i)) {
      var channel = this.channels[i];
      if (channel.state == channel.PENDING) {
        pendingChannels.push(channel);
      }
    }
  }

  pendingChannels.sort(function (a, b) {
    var ap = a.priority || 0;
    var bp = b.priority || 0;
    if (ap > bp) {
      return -1;
    }
    if (ap < bp) {
      return 1;
    }
    return 0;
  });

  pendingChannels.forEach(function (channel) {
    self._trySubscribe(channel);
  });
};

SCSocket.prototype.watch = function (channelName, handler) {
  if (typeof handler != 'function') {
    throw new InvalidArgumentsError('No handler function was provided');
  }
  this._channelEmitter.on(channelName, handler);
};

SCSocket.prototype.unwatch = function (channelName, handler) {
  if (handler) {
    this._channelEmitter.removeListener(channelName, handler);
  } else {
    this._channelEmitter.removeAllListeners(channelName);
  }
};

SCSocket.prototype.watchers = function (channelName) {
  return this._channelEmitter.listeners(channelName);
};

module.exports = SCSocket;

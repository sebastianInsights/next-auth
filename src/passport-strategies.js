/*
 * Configures Passport Strategies
 */
'use strict'

const passport = require('passport')

module.exports = ({
  expressApp = null, // Express Server
  pathPrefix = '/auth', // URL base path for authentication routes
  providers = [],
  serverUrl = null,
  callbackUrl = null,
  functions = {
    find: ({
      id,
      email,
      emailToken,
      provider
    } = {}, req) => {},
    update: (user, profile, params={}, req) => {},
    insert: (user, profile, params={}, req) => {},
    serialize: (user) => {},
    deserialize: (id) => {}
  }
} = {}) => {
  if (expressApp === null) {
    throw new Error('expressApp must be an instance of an express server')
  }

  if (typeof(functions) !== 'object') {
    throw new Error('functions must be a an object')
  }

  /*
   * Return functions ID property from a functions object
   */
  passport.serializeUser((user, next) => {
    functions.serialize(user)
    .then(id => {
      next(null, id)
    })
    .catch(err => {
      next(err, false)
    })
  })

  /*
   * Return functions from a functions ID
   */
  passport.deserializeUser((id, next) => {
    functions.deserialize(id)
    .then(user => {
      if (!user) return next(null, false)
      next(null, user)
    })
    .catch(err => {
      next(err, false)
    })
  })

  // Define a Passport strategy for provider
  providers.forEach(({
    providerName,
    Strategy,
    strategyOptions,
    getProfile
  }) => {

    strategyOptions.callbackURL = (strategyOptions.callbackURL || (serverUrl || callbackUrl || '') + `${pathPrefix}/oauth/${providerName.toLowerCase()}/callback`)
    strategyOptions.passReqToCallback = true

    passport.use(providerName, new Strategy(strategyOptions, (req, accessToken, refreshToken, _params, _profile, next) => {

      try {
        // Normalise the provider specific profile into a standard basic
        // profile object with just { id, name, email } properties.
        let profile = getProfile(_profile)

        const linkToExistingAccount = user => {
          const nextUser = Object.assign({}, user)

          // If we don't already have a name for the user, use value the
          // name value specfied in their profile on the remote service.
          nextUser.name = user.name || profile.name

          // If we don't have a real email address for the user, use the
          // email value specified in their profile on the remote service.
          if (
            user.email &&
            user.email.match(/.*@localhost\.localdomain$/) &&
            profile.email &&
            !profile.email.match(/.*@localhost\.localdomain$/)
          ) {
            nextUser.emailVerified = false
            nextUser.email = profile.email
          }

          // Save Profile ID, Access Token and Refresh Token values
          // to the users local account, which links the accounts.
          nextUser[providerName.toLowerCase()] = {
            id: profile.id,
            accessToken: accessToken,
            refreshToken: refreshToken
          };

          // Update details for the new provider for this user.
          return functions.update(nextUser, _profile, _params, req)
        }

        // Save the Access Token to the current session.
        req.session[providerName.toLowerCase()] = {
          accessToken: accessToken
        }

        // If we didn't get an email address from the oAuth provider then
        // generate a unique one as placeholder, using Provider name and ID.
        //
        // If you want users to specify a valid email address after signing in,
        // you can check for email addresses ending "@localhost.localdomain"
        // and prompt those users to supply a valid address.
        if (!profile.email) {
          profile.email = `${providerName.toLowerCase()}-${profile.id}@localhost.localdomain`
        }

        // Look for a user in the database associated with this account.
        functions.find({
          provider: {
            name: providerName.toLowerCase(),
            id: profile.id
          }
        }, req)
        .then(user => {
          if (req.user) {
            // This section handles scenarios when a user is already signed in.

            if (user) {
              // This section handles if the user is already logged in
              if (req.user.id === user.id) {
                // This section handles if the user is already logged in and is
                // already linked to local account they are signed in with.
                // If they are, all we need to do is update the Refresh Token
                // value if we got one.
                if (refreshToken) {
                  user[providerName.toLowerCase()] = {
                    id: profile.id,
                    accessToken: accessToken,
                    refreshToken: refreshToken
                  }

                  functions.update(user, _profile, _params, req)
                  .then(user => {
                    return next(null, user)
                  })
                  .catch(err => {
                    next(err)
                  })
                } else {
                  return next(null, user)
                }
              } else {
                // This section handles if a user is logged in but the oAuth
                // account they are trying to link to is already linked to a
                // different local account.

                // This prevents users from linking an oAuth account to more
                // than one local account at the same time.
                return next(null, false)
              }
            } else {
              // This secion handles if a user is already logged in and is
              // trying to link a new account to the existing local account.

              // First get the User ID from the User, then look up the user
              // details. Note: We don't use the User object in req.user
              // directly as it is a simplified set of properties set by
              // functions.deserialize().
              return functions.serialize(req.user)
              .then(id => {
                if (!id) throw new Error("Unable to serialize user")
                return functions.find({ id: id }, req)
              })
              .then(user => {
                // This error should not happen, unless the currently signed in
                // user has been deleted deleted from the database since
                // signing in (or there is a problem talking to the database).
                if (!user) return next(new Error("Unable to look up account for current user"), false);
                return linkToExistingAccount(user)
              })
              .then(user => {
                next(null, user)
              })
              .catch(err => next(err, false));
            }

          } else {
            // This section handles scenarios when a user is not logged in.

            if (user) {
              // This section handles senarios where the user is not logged in
              // but they seem to have an account already, so we sign them in
              // as that user.

              // Update Access and Refresh Tokens for the user if we got them.
              if (accessToken || refreshToken) {
                if (accessToken) user[providerName.toLowerCase()].accessToken = accessToken
                if (refreshToken) user[providerName.toLowerCase()].refreshToken = refreshToken
                return functions.update(user, _profile, _params, req)
                .then(user => {
                  return next(null, user)
                })
                .catch(err => {
                  return next(err, false)
                })
              } else {
                return next(null, user)
              }
            } else {
              // This section handles senarios where the user is not logged in
              // and they don't have a local account already.

              // First we check to see if a local account with the same email
              // address as the one associated with their oAuth profile exists.
              //
              // This is so they can't accidentally end up with two accounts
              // linked to the same email address.
              return functions.find({email: profile.email}, req)
              .then(user => {

                if (user) {
                  // We already have a local account associated with their
                  // email address.

                  // If the provider is trustworthy and doesn't allow to create accounts
                  // for another user emails, then we allow to link this new account to
                  // the corresponding local account.
                  //
                  // Note: By default, we treat all providers as not trustworthy. Enable
                  // the `trustedIdentity` flag at your own risk and only to those providers,
                  // who you are sure will guarantee that identities can not be spoofed.
                  const provider = providers.find(provider => provider.providerName === providerName)
                  if (provider && provider.trustedIdentity) {
                    return linkToExistingAccount(user)
                    .then(user => {
                      next(null, user)
                    })
                    .catch(err => next(err, false))
                  }

                  // Otherwise, the user should sign in with his/her local account first -
                  // and then they can link accounts if they wish.
                  //
                  // Note: Automatically linking insufficiently trusted accounts here could
                  // expose a potential security exploit allowing someone to pre-register
                  // or create an account elsewhere for another users email
                  // address then trying to sign in from it, so don't do that.
                  return next(null, false)
                }

                // If an account does not exist, create one for them and return
                // a user object to passport, which will sign them in.
                return functions.insert({
                  name: profile.name,
                  email: profile.email,
                  [providerName.toLowerCase()]: {
                    id: profile.id,
                    accessToken: accessToken,
                    refreshToken: refreshToken
                  }
                }, _profile, _params, req)
                .then(user => {
                  return next(null, user)
                })
                .catch(err => {
                  return next(err, false)
                })
              })
            }
          }
        })
        .catch(err => {
          next(err, false)
        })
      } catch (err) {
        return next(err, false)
      }

    }))
  })

  // Initialise Passport
  expressApp.use(passport.initialize())
  expressApp.use(passport.session())

  // Add routes for each provider
  providers.forEach(({
    providerName,
    providerOptions
  }) => {
    // Route to start sign in
    expressApp.get(
        `${pathPrefix}/oauth/${providerName.toLowerCase()}`,
        (req, res, next) => {
          passport.authenticate(providerName, {
            ...providerOptions,
            state: Buffer.from(
                JSON.stringify({
                  originalHost: req.headers.host,
                  returnTo: req.query.returnTo,
                }),
            ).toString("base64"),
          })(req, res, next);
        },
    );

    // Route to call back to after signing in
    expressApp.get(
        `${pathPrefix}/oauth/${providerName.toLowerCase()}/callback`,
        (req, res, next) => {
          let parsedState = null;

          if (req.query.state) {
            try {
              parsedState = JSON.parse(Buffer.from(req.query.state, "base64").toString());
              if (parsedState.originalHost && parsedState.originalHost !== req.headers.host) {
                res.redirect(
                    `https://${parsedState.originalHost}${req.originalUrl}`,
                );
                return;
              }
            } catch (b64err) {
              debugger;
            }
          }

          let successRedirect = `${pathPrefix}/callback?action=signin&service=${providerName}`;
          let failureRedirect = `${pathPrefix}/error?action=signin&type=oauth&service=${providerName}`;
          if(parsedState && parsedState.returnTo){
            successRedirect = `${successRedirect}&returnTo=${parsedState.returnTo}`;
            failureRedirect = `${failureRedirect}&returnTo=${parsedState.returnTo}`;
          }

          passport.authenticate(providerName, { successRedirect, failureRedirect })(req, res, next);
        },
    );

    // Route to post to unlink accounts
    expressApp.post(`${pathPrefix}/oauth/${providerName.toLowerCase()}/unlink`, (req, res, next) => {
      if (!req.user) {
        return next(new Error('Not signed in'))
      }

      // First get the User ID from the User, then look up the user details.
      // Note: We don't use the User object in req.user directly as it is a
      // a simplified set of properties set by functions.deserialize().
      functions.serialize(req.user)
      .then(id => {
        if (!id) throw new Error("Unable to serialize user")
        return functions.find({ id: id })
      })
      .then(user => {
        if (!user) return next(new Error('Unable to look up account for current user'))

        // Remove connection between user account and oauth provider
        if (user[providerName.toLowerCase()]) {
          delete user[providerName.toLowerCase()]
        }

        return functions.update(user, null, { delete: providerName.toLowerCase() })
        .then(user => {
          return res.redirect(`${pathPrefix}/callback?action=unlink&service=${providerName.toLowerCase()}`)
        })
        .catch(err => {
          return next(err, false)
        })
      })
    })
  })

  // A catch all for providers that are not configured
  expressApp.get(`${pathPrefix}/oauth/:provider`, (req, res) => {
    return res.redirect(`${pathPrefix}/error?action=signin&type=unsupported`)
  })
}
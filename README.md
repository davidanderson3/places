# Places App

## Inspecting runtime Firebase configuration

When the app loads it exposes the effective Firebase configuration on the
`window.__placesFirebaseConfig` global. Open the browser DevTools console on the
running app and execute:

```js
window.__placesFirebaseConfig
```

This logs the configuration object that Firebase initialized with, letting you
confirm whether the default keys or any runtime overrides (for example
`window.firebaseConfig`) were used.

You can also check `firebase.app().options` after the app initializes Firebase.

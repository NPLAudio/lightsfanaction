import streamDeck from '@elgato/streamdeck'
import { BrightnessAction, CoolerAction, EffectAction, FanAction, SensorAction } from './actions.js'
import { DisplayKeyAction } from './surface/display.js'

// The plugin runs as its own process, and an error nobody caught would end it, leaving every key offline until the
// Stream Deck software restarts it. Log such errors and carry on instead.
process.on('uncaughtException', (e) => streamDeck.logger.error(`uncaught exception: ${e}`))
process.on('unhandledRejection', (e) => streamDeck.logger.error(`unhandled rejection: ${e}`))

streamDeck.actions.registerAction(new SensorAction())
streamDeck.actions.registerAction(new FanAction())
streamDeck.actions.registerAction(new CoolerAction())
streamDeck.actions.registerAction(new EffectAction())
streamDeck.actions.registerAction(new BrightnessAction())
streamDeck.actions.registerAction(new DisplayKeyAction())

void streamDeck.connect()

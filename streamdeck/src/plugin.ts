import streamDeck from '@elgato/streamdeck'
import { BrightnessAction, CoolerAction, EffectAction, FanAction, SensorAction } from './actions.js'

streamDeck.actions.registerAction(new SensorAction())
streamDeck.actions.registerAction(new FanAction())
streamDeck.actions.registerAction(new CoolerAction())
streamDeck.actions.registerAction(new EffectAction())
streamDeck.actions.registerAction(new BrightnessAction())

void streamDeck.connect()

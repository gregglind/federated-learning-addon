'use strict'

ChromeUtils.import('resource://gre/modules/PlacesUtils.jsm')

const CHUNK_SIZE = 1000

async function removeFrecencyTrigger () {
  return await PlacesUtils.withConnectionWrapper("federated-learning", async db => {
    db.execute('DROP TRIGGER IF EXISTS moz_places_afterupdate_frecency_trigger')
  })
}

async function restoreFrecencyTrigger () {
  // Query from https://dxr.mozilla.org/mozilla-central/source/toolkit/components/places/nsPlacesTriggers.h#176
  return await PlacesUtils.withConnectionWrapper("federated-learning", async db => {
    db.execute(`
CREATE TEMP TRIGGER moz_places_afterupdate_frecency_trigger AFTER UPDATE OF frecency ON moz_places FOR EACH ROW WHEN NEW.frecency >= 0 AND NOT is_frecency_decaying() BEGIN UPDATE moz_origins SET frecency = ( SELECT IFNULL(MAX(frecency), 0) FROM moz_places WHERE moz_places.origin_id = moz_origins.id  ) WHERE id = NEW.origin_id; INSERT OR REPLACE INTO moz_meta(key, value) VALUES ( 'frecency_count', CAST(IFNULL((SELECT value FROM moz_meta WHERE key = 'frecency_count'), 0) AS INTEGER) - (CASE WHEN OLD.frecency <= 0 OR OLD.id < 0 THEN 0 ELSE 1 END) + (CASE WHEN NEW.frecency <= 0 OR NEW.id < 0 THEN 0 ELSE 1 END)  ), ( 'frecency_sum', CAST(IFNULL((SELECT value FROM moz_meta WHERE key = 'frecency_sum'), 0) AS INTEGER) - (CASE WHEN OLD.frecency <= 0 OR OLD.id < 0 THEN 0 ELSE OLD.frecency END) + (CASE WHEN NEW.frecency <= 0 OR NEW.id < 0 THEN 0 ELSE NEW.frecency END)  ), ( 'frecency_sum_of_squares', CAST(IFNULL((SELECT value FROM moz_meta WHERE key = 'frecency_sum_of_squares'), 0) AS INTEGER) - (CASE WHEN OLD.frecency <= 0 OR OLD.id < 0 THEN 0 ELSE OLD.frecency * OLD.frecency END) + (CASE WHEN NEW.frecency <= 0 OR NEW.id < 0 THEN 0 ELSE NEW.frecency * NEW.frecency END)  ); END
    `)
  })
}

async function getMozPlacesCount () {
  let res = await PlacesUtils.withConnectionWrapper('federated-learning', async db => db.execute('SELECT COUNT(*) as count FROM moz_places'))
  return res[0].getResultByName('count')
}

var frecency = class extends ExtensionAPI {
  getAPI () {
    return {
      experiments: {
        frecency: {
          async calculateByURL (url) {
            let res = await PlacesUtils.withConnectionWrapper("federated-learning", async db => db.execute(
              "SELECT CALCULATE_FRECENCY(id) as frecency FROM moz_places WHERE url_hash = hash(?)", [url])
            )
            if (res.length >= 1) {
              return res[0].getResultByName('frecency')
            } else {
              return -1
            }
          },

          async updateAllFrecencies () {
            await removeFrecencyTrigger()

            let count = await getMozPlacesCount()
            let promises = []

            for (let i = 0; i < count; i += CHUNK_SIZE) {
              await PlacesUtils.withConnectionWrapper('frecency-update', async (db) => {
                await db.execute(`UPDATE moz_places SET frecency = CALCULATE_FRECENCY(id) WHERE id in (
                SELECT id FROM moz_places ORDER BY id LIMIT ? OFFSET ?
              )`, [CHUNK_SIZE, i])
              })

              // In the last iteration we want to check if new rows were added
              if (i + CHUNK_SIZE >= count) {
                count = await getMozPlacesCount()
              }
            }

            return await restoreFrecencyTrigger()
          }
        }
      }
    }
  }
}

# Benchmark after-batching-2026-10-25

Provider: openai. 2 run(s) per site. Tokens are the harness's: uncached input + output, with prompt-cache reads apart.

| Site | Run | Status | Tools validated (HTTP / browser) | Main task | Required inputs | Main task fields (filled) | Structured tools | Agent turns | Tokens (uncached in + out) | Cache reads | Wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| haraj | 1 | completed | 10/10 (5 / 5) | yes: search_classified_ads (http) | query | 34 (79%) | 8/8 | 5 | 42k | 92k | 191 s |
| haraj | 2 | completed | 11/13 (6 / 5) | yes: search_classified_ads_by_city (http) | query, city | 2 (100%) | 10/10 | 11 | 113k | 233k | 248 s |
| sar | 1 | completed | 5/5 (2 / 3) | yes: search_train_trips (browser) | departure_station, arrival_station, departure_date, trip_direction | 1 (100%) | 3/4 | 17 | 75k | 246k | 231 s |
| sar | 2 | completed | 6/6 (2 / 4) | yes: list_train_trips (browser) | departure_station, arrival_station, departure_date | 8 (100%) | 2/3 | 19 | 109k | 295k | 247 s |
| syarah | 1 | completed | 32/33 (15 / 17) | yes: search_car_inventory (browser) | query | 6 (83%) | 29/29 | 14 | 110k | 364k | 368 s |
| syarah | 2 | completed | 31/36 (17 / 14) | yes: search_cars (browser) | query | 2 (100%) | 28/28 | 12 | 96k | 313k | 330 s |

## Per site

### sar

Main task: Search passenger train trips between two stations on a date. Covered in 2/2 run(s). Mean validated tools 6 (2 HTTP). Mean harness tokens 92k uncached, 270k cached. Mean wall 239 s.

- Run 1: kept search_train_trips, get_information_page_data, list_passenger_service_pages, list_popular_booking_routes; 1 rejected; the model ended its turn without calling finish; API gaps: no-mechanics 1, client-rendered 1.
- Run 2: kept list_train_trips, get_content_page, get_content_page_data, list_northern_train_stations, list_featured_route_offers; 1 rejected; the model ended its turn without calling finish; API gaps: no-sample 3.

### syarah

Main task: Search cars by free-text keyword. Covered in 2/2 run(s). Mean validated tools 32 (16 HTTP). Mean harness tokens 103k uncached, 338k cached. Mean wall 349 s.

- Run 1: kept list_used_cars, list_new_cars, list_cars_by_make_model, list_cars_by_make_model_year, list_financed_cars_by_make, list_financed_cars_by_make_model, list_cars_by_origin_country, search_car_inventory; 1 rejected; finished: Modeled Syarah as a Saudi car marketplace. Updated car/oil entity descriptions, added validated browser/page tools for used cars, new cars, make+model, make+model+year, financing by make/model, origin country, and a validated browser workflow search_car_inventory that extracts full result cards from; failed validation: list_cars_by_make_en_browser; API gaps: client-rendered 2, no-mechanics 1.
- Run 2: kept list_used_cars, list_new_cars, list_cars_by_city_en, list_cars_by_country_en, list_cars_by_make_model, list_used_cars_en, list_new_cars_en; 1 rejected; finished: Updated the Syarah model around the main car-marketplace task. Renamed/described car and motor-oil entities, clarified existing car search/list/detail capabilities, dropped a flawed financing-list capability, and validated new browser/page listing tools for used cars, new cars, make+model, English u; failed validation: list_cars_by_make_or_category_browser, list_cars_by_make_model_year, list_used_cars_browser, list_new_cars_en_browser, list_used_cars_en_browser; API gaps: credentialed 1, no-sample 1.

### haraj

Main task: Search classified posts by keyword. Covered in 2/2 run(s). Mean validated tools 11 (6 HTTP). Mean harness tokens 77k uncached, 162k cached. Mean wall 219 s.

- Run 1: kept get_classified_ad_en, list_latest_classified_ads, list_classified_ads_by_tag; 2 rejected; finished: Renamed the marketplace entity to classified_ad, improved the existing search/detail capability names and descriptions, and added validated browser tools for latest ads, ads by tag/category, and English-UI ad detail pages. Site summary updated with main-task hypotheses and API scope caveat..
- Run 2: kept list_recent_classified_ads, list_classified_ads_by_tag, list_classified_ads_by_city, search_classified_ads_by_city, get_classified_ad_en, list_trending_search_keywords, search_haraj_classified_ads; 4 rejected; finished: Modeled Haraj as a classified-ads marketplace. Renamed the entity to classified_ad, dropped duplicate/mechanical observed search/detail capabilities, and added validated tools for recent ads, keyword search, tag/category listing, city listing, city-constrained search, English ad detail pages, and a ; failed validation: list_classified_ads_by_city, list_classified_ads_by_city_browser.


import requests
import json
from collections import defaultdict
from datetime import datetime
import time

API_KEY = "328d49c810214ebe9098321dffcac80e"
BASE_URL = "https://api.artdatabanken.se/species-observation-system/v1"

headers = {
    "Ocp-Apim-Subscription-Key": API_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

# The result dictionary will store the set of years for each MM-DD
date_years = defaultdict(set)

for year in range(2000, 2027):
    print(f"Fetching {year}...")
    
    body = {
        "taxon": {"ids": [100058], "includeUnderlyingTaxa": True},
        "geographics": {"areas": [{"areaType": "County", "featureId": "12"}]},
        "date": {
            "startDate": f"{year}-01-01",
            "endDate": f"{year}-12-31",
            "dateFilterType": "BetweenStartDateAndEndDate"
        }
    }
    
    skip = 0
    take = 1000
    while True:
        url = f"{BASE_URL}/Observations/Search?skip={skip}&take={take}&translationCultureCode=sv-SE"
        resp = requests.post(url, headers=headers, json=body)
        
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            print(f"Rate limit, waiting {wait}s...")
            time.sleep(wait)
            continue
            
        if resp.status_code != 200:
            print(f"Error {resp.status_code}: {resp.text}")
            break
            
        data = resp.json()
        records = data if isinstance(data, list) else data.get("records", [])
        
        if not records:
            break
            
        for obs in records:
            event = obs.get("event", {})
            start_date_str = event.get("startDate")
            if start_date_str:
                # Expected format: YYYY-MM-DD...
                try:
                    dt = datetime.strptime(start_date_str[:10], "%Y-%m-%d")
                    mm_dd = dt.strftime("%m-%d")
                    obs_year = dt.year
                    date_years[mm_dd].add(obs_year)
                except ValueError:
                    pass
                    
        skip += take
        if len(records) < take:
            break
            
    # Small delay to respect rate limit
    time.sleep(0.5)

# Convert sets to counts
final_counts = {}
for mm_dd, years_set in date_years.items():
    final_counts[mm_dd] = len(years_set)

output_path = "/Users/hakankarlsson/Library/CloudStorage/GoogleDrive-hlg.karlsson@gmail.com/Min enhet/🌎GAIA/GAIA-Tools/SkrivBord/mindre_flugsnappare.json"
with open(output_path, "w") as f:
    json.dump(final_counts, f)

print(f"Saved {len(final_counts)} days to {output_path}")

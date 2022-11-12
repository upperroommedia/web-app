import json
from fuzzywuzzy import fuzz
speakers = json.load(open('newSpeakersToUpload.json'))
newlist = sorted(speakers, key=lambda x: x['name'])
count = 0
for index, value in enumerate(newlist):
    name = value['name']
    found = False
    for j in range(index, len(newlist)):
        toCompare = newlist[j]['name']
        if fuzz.ratio(name, toCompare) > 75 and name != toCompare:
            if not found:
                count += 1
                print(name, end='')
                found = True
            print(f": {toCompare}", end='')
    if found:
        print()

# speaker tag: remove dots from everything
#
print(count)

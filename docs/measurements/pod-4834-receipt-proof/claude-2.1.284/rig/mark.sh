#!/bin/bash
# mark.sh RUN LABEL — append "LABEL <ms>" to the run's marks.txt
echo "$2 $(date +%s%3N)" >> $(dirname "$0")/../runs/$1/marks.txt
